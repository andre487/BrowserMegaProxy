import { requestWithRetry } from './http-request.mjs'
import { reportStoreDashboard } from './store-materials.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { validateVersion } from './release.mjs'

export async function publishChromeWebStore(
  tag,
  archive,
  { env = process.env, request = fetch, wait = setTimeout, retryWait, dryRun = false } = {}
) {
  assert.match(tag, /^v\d+\.\d+\.\d+$/)
  validateVersion(tag.slice(1))
  for (const key of [
    'CWS_PUBLISHER_ID',
    'CWS_EXTENSION_ID',
    'CWS_CLIENT_ID',
    'CWS_CLIENT_SECRET',
    'CWS_REFRESH_TOKEN'
  ]) {
    assert.ok(env[key]?.trim(), `Configure ${key}`)
  }
  const secrets = [env.CWS_CLIENT_SECRET, env.CWS_REFRESH_TOKEN]
  const json = async (url, options = {}) => {
    const response = await requestWithRetry(
      request,
      url,
      { ...options, signal: AbortSignal.timeout(60000) },
      { secrets, wait: retryWait }
    )
    if (!response.ok) {
      throw await globalThis.MegaErrors.httpError(
        response,
        `Chrome Web Store ${options.method || 'GET'} ${url} failed: HTTP ${response.status}`,
        secrets
      )
    }
    return response.json()
  }
  const token = await json('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.CWS_CLIENT_ID,
      client_secret: env.CWS_CLIENT_SECRET,
      refresh_token: env.CWS_REFRESH_TOKEN
    })
  })
  assert.ok(token.access_token, 'OAuth response missing access token')
  secrets.push(token.access_token)
  const name = `publishers/${encodeURIComponent(env.CWS_PUBLISHER_ID)}/items/${encodeURIComponent(env.CWS_EXTENSION_ID)}`
  const base = `https://chromewebstore.googleapis.com/v2/${name}`
  const headers = { Authorization: `Bearer ${token.access_token}` }
  const status = await json(`${base}:fetchStatus`, { headers })
  if (dryRun) {
    return `Chrome Web Store ${tag}: dry run passed (authenticated; no upload or submission)`
  }
  for (const revision of [status.publishedItemRevisionStatus, status.submittedItemRevisionStatus]) {
    if (
      ['PUBLISHED', 'PUBLISHED_TO_TESTERS', 'PENDING_REVIEW'].includes(revision?.state) &&
      revision.distributionChannels?.some(channel => channel.crxVersion === tag.slice(1))
    ) {
      return `Chrome Web Store ${tag}: ${revision.state} (already submitted)`
    }
  }
  const uploaded = await json(`https://chromewebstore.googleapis.com/upload/v2/${name}:upload`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/zip' },
    body: archive
  })
  let state = uploaded.uploadState
  for (let attempt = 0; state === 'IN_PROGRESS' && attempt < 30; attempt++) {
    await wait(5000)
    state = (await json(`${base}:fetchStatus`, { headers })).lastAsyncUploadState
  }
  assert.equal(state, 'SUCCEEDED', `Chrome Web Store upload did not succeed: ${state}`)
  const published = await json(`${base}:publish`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' })
  })
  assert.ok(
    ['PENDING_REVIEW', 'PUBLISHED', 'PUBLISHED_TO_TESTERS'].includes(published.state),
    `Unexpected Chrome Web Store submission state: ${published.state}`
  )
  return `Chrome Web Store ${tag}: ${published.state}`
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2]
  assert.match(tag || '', /^v\d+\.\d+\.\d+$/)
  await reportStoreDashboard('Chrome Web Store', 'https://chrome.google.com/webstore/devconsole')
  const file = `dist/release/MegaProxy-chromium-${tag}.zip`
  execFileSync('unzip', ['-t', file], { stdio: 'pipe' })
  const manifest = JSON.parse(
    execFileSync('unzip', ['-p', file, 'manifest.json'], { encoding: 'utf8' })
  )
  assert.equal(manifest.version, tag.slice(1), 'Archive version must match release tag')
  const archive = await readFile(file)
  try {
    const { checkChromeStoreMaterials } = await import('./chrome-store-materials.mjs')
    await checkChromeStoreMaterials({ tag })
  } catch (error) {
    console.warn(
      `::warning title=Chrome Web Store materials::Freshness check unavailable: ${error.message.replace(/[\r\n]/gu, ' ')}`
    )
  }
  const result = await publishChromeWebStore(tag, archive, {
    dryRun: process.env.CWS_DRY_RUN === 'true'
  })
  console.log(result)
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${result}\n`)
  }
}
