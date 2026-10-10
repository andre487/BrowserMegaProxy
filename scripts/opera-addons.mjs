import { requestWithRetry } from './http-request.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { validateVersion } from './release.mjs'

export async function submitOperaAddon(
  tag,
  archive,
  { env = process.env, request = fetch, wait = setTimeout, retryWait, dryRun = false } = {}
) {
  assert.match(tag || '', /^v\d+\.\d+\.\d+$/)
  const version = validateVersion(tag.slice(1))
  assert.match(env.OPERA_PACKAGE_ID || '', /^[1-9]\d*$/, 'Configure OPERA_PACKAGE_ID')
  assert.ok(/^[^;\s]+$/.test(env.OPERA_SESSION_ID || ''), 'Configure OPERA_SESSION_ID')
  assert.ok(archive.length, 'Empty extension archive')
  const packageId = env.OPERA_PACKAGE_ID
  const csrf = randomBytes(16).toString('hex')
  // ponytail: undocumented dashboard API; update endpoints if Opera changes the cabinet.
  const api = async (endpoint, { method = 'GET', body, raw = false } = {}) => {
    const response = await requestWithRetry(
      (url, options) => request(url, { ...options, signal: AbortSignal.timeout(180000) }),
      `https://addons.opera.com/api/${endpoint}`,
      {
        method,
        redirect: 'error',
        headers: {
          Accept: 'application/json; version=1.0',
          Cookie: `sessionid=${env.OPERA_SESSION_ID}; csrftoken=${csrf}`,
          'X-CSRFToken': csrf,
          Origin: 'https://addons.opera.com',
          Referer: `https://addons.opera.com/developer/package/${packageId}/`,
          ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {})
        },
        body:
          body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body)
      },
      {
        secrets: [env.OPERA_SESSION_ID, csrf],
        wait: retryWait,
        maxAttempts: 6,
        initialDelay: 10000
      }
    )
    if (!response.ok) {
      throw await globalThis.MegaErrors.httpError(
        response,
        `Opera ${method} ${endpoint} failed: HTTP ${response.status}`,
        [env.OPERA_SESSION_ID, csrf]
      )
    }
    if (raw) {
      return
    }
    const result = await response.json()
    assert.ok(!result.detail, 'Opera API rejected the request; check the developer dashboard')
    return result
  }
  const addon = await api(`developer/packages/${packageId}/`)
  assert.equal(addon.id, Number(packageId), 'Unexpected Opera package')
  assert.equal(addon.is_editable, true, 'Opera package is not editable by this account')
  const existing = addon.versions?.find(item => item.version === version)
  const previous = addon.versions?.find(item => item.version !== version) || existing
  assert.ok(previous, 'Create the initial Opera listing and version in the developer dashboard')
  const details = await api(`developer/package-versions/${packageId}-${previous.version}/`)
  assert.ok(
    details.translations?.en?.short_description,
    'Previous Opera version needs an English summary'
  )
  if (dryRun) {
    const page = await request(`https://addons.opera.com/developer/package/${packageId}/`, {
      redirect: 'error', headers: { Cookie: `sessionid=${env.OPERA_SESSION_ID}` }
    })
    assert.ok(page.ok, 'Could not read Opera developer page')
    const html = await page.text()
    for (const match of html.matchAll(/<script[^>]+src=[\"']([^\"']+)/g)) console.log('Opera script:', match[1])
    return `Opera ${tag}: dry run passed (authenticated; no upload or submission)`
  }
  if (existing?.submitted_for_moderation) {
    return `Opera ${tag}: already submitted for moderation`
  }
  const versionPath = `developer/package-versions/${packageId}-${version}/`
  if (!existing) {
    const fileName = `MegaProxy-chromium-${tag}.zip`
    const fileId = `${archive.length}-${fileName.replace(/[^0-9a-zA-Z_-]/g, '')}`
    const chunkSize = 1024 * 1024
    for (let offset = 0; offset < archive.length; offset += chunkSize) {
      const chunk = archive.subarray(offset, offset + chunkSize)
      const form = new FormData()
      form.append('file', new Blob([chunk]), fileName)
      for (const [key, value] of Object.entries({
        flowChunkNumber: offset / chunkSize + 1,
        flowChunkSize: chunkSize,
        flowCurrentChunkSize: chunk.length,
        flowTotalSize: archive.length,
        flowIdentifier: fileId,
        flowFilename: fileName,
        flowRelativePath: fileName,
        flowTotalChunks: Math.ceil(archive.length / chunkSize)
      })) {
        form.append(key, String(value))
      }
      await api('file-upload/', { method: 'POST', body: form, raw: true })
    }
    // Opera can take a few seconds to make uploaded chunks available to validation.
    for (let attempt = 0; ; attempt++) {
      try {
        const validated = await api(`developer/package-versions/?package_id=${packageId}`, {
          method: 'POST',
          body: { file_id: fileId, file_name: fileName, metadata_from: previous.version }
        })
        assert.equal(validated.version, version, 'Uploaded Opera version must match the release')
        break
      } catch (error) {
        if (attempt >= 11 || ![400, 404].includes(error.status)) {
          throw error
        }
        await wait(5000)
      }
    }
  }
  // The dashboard copies metadata but can omit summaries; preserve all existing locales.
  const translations = Object.fromEntries(
    Object.entries(details.translations)
      .filter(([, value]) => value.short_description)
      .map(([locale, value]) => [locale, { short_description: value.short_description }])
  )
  await api(versionPath, { method: 'PATCH', body: { translations } })
  const submitted = await api(`${versionPath}submit_for_moderation/`, { method: 'POST' })
  assert.equal(submitted.version, version)
  assert.equal(submitted.submitted_for_moderation, true, 'Opera did not confirm submission')
  return `Opera ${tag}: submitted for moderation`
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2]
  assert.match(tag || '', /^v\d+\.\d+\.\d+$/)
  const file = `dist/release/MegaProxy-chromium-${tag}.zip`
  execFileSync('unzip', ['-t', file], { stdio: 'pipe' })
  const manifest = JSON.parse(
    execFileSync('unzip', ['-p', file, 'manifest.json'], { encoding: 'utf8' })
  )
  assert.equal(manifest.version, tag.slice(1), 'Archive version must match release tag')
  const result = await submitOperaAddon(tag, await readFile(file), {
    dryRun: process.env.OPERA_DRY_RUN === 'true'
  })
  console.log(result)
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${result}\n`)
  }
}
