import { requestWithRetry } from './http-request.mjs'
import { readStoreFile, reportStoreDashboard } from './store-materials.mjs'
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
  {
    env = process.env,
    request = fetch,
    wait = setTimeout,
    retryWait,
    dryRun = false,
    readMaterial,
    warn = console.warn
  } = {}
) {
  assert.match(tag || '', /^v\d+\.\d+\.\d+$/)
  const version = validateVersion(tag.slice(1))
  assert.match(env.OPERA_PACKAGE_ID || '', /^[1-9]\d*$/, 'Configure OPERA_PACKAGE_ID')
  assert.ok(/^[^;\s]+$/.test(env.OPERA_SESSION_ID || ''), 'Configure OPERA_SESSION_ID')
  assert.ok(archive.length, 'Empty extension archive')
  const packageId = env.OPERA_PACKAGE_ID
  const csrf = randomBytes(16).toString('hex')
  // ponytail: undocumented dashboard API; update endpoints if Opera changes the cabinet.
  const api = async (endpoint, { method = 'GET', body, raw = false, signal } = {}) => {
    const response = await requestWithRetry(
      (url, options) => {
        signal?.throwIfAborted()
        const timeout = AbortSignal.timeout(180000)
        return request(url, {
          ...options,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout
        })
      },
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
        wait: retryWait || (ms => setTimeout(ms, undefined, { signal })),
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
  const upload = async (data, fileName, uploadApi = api) => {
    const fileId = `${data.length}-${fileName.replace(/[^0-9a-zA-Z_-]/g, '')}`
    const chunkSize = 1024 * 1024
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const chunk = data.subarray(offset, offset + chunkSize)
      const form = new FormData()
      form.append('file', new Blob([chunk]), fileName)
      for (const [key, value] of Object.entries({
        flowChunkNumber: offset / chunkSize + 1,
        flowChunkSize: chunkSize,
        flowCurrentChunkSize: chunk.length,
        flowTotalSize: data.length,
        flowIdentifier: fileId,
        flowFilename: fileName,
        flowRelativePath: fileName,
        flowTotalChunks: Math.ceil(data.length / chunkSize)
      })) {
        form.append(key, String(value))
      }
      await uploadApi('file-upload/', { method: 'POST', body: form, raw: true })
    }
    return fileId
  }
  const addon = await api(`developer/packages/${packageId}/`)
  assert.equal(addon.id, Number(packageId), 'Unexpected Opera package')
  assert.equal(addon.is_editable, true, 'Opera package is not editable by this account')
  const existing = addon.versions?.find(item => item.version === version)
  const previous = addon.versions?.find(item => item.version !== version) || existing
  assert.ok(previous, 'Create the initial Opera listing and version in the developer dashboard')
  if (dryRun) {
    await api(`developer/package-versions/${packageId}-${previous.version}/`)
    return `Opera ${tag}: dry run passed (authenticated; no upload or submission)`
  }
  if (existing?.submitted_for_moderation) {
    return `Opera ${tag}: already submitted for moderation`
  }
  const versionPath = `developer/package-versions/${packageId}-${version}/`
  if (!existing) {
    const fileName = `MegaProxy-chromium-${tag}.zip`
    const fileId = await upload(archive, fileName)
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
  const warnings = []
  let materialSignal
  const attemptMaterial = async (name, action) => {
    try {
      materialSignal = AbortSignal.timeout(60000)
      return await action()
    } catch (error) {
      const message = globalThis.MegaErrors.responseText(`Opera ${name}: ${error.message}`, [
        env.OPERA_SESSION_ID,
        csrf
      ])
      warnings.push(message)
      if (env.GITHUB_STEP_SUMMARY) {
        try {
          await appendFile(env.GITHUB_STEP_SUMMARY, `- Warning: ${message}\n`)
        } catch (summaryError) {
          warn(
            `Opera warning summary could not be written: ${summaryError.code || 'Unknown error'}`
          )
        }
      }
      warn(
        `::warning title=Opera materials::${message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`
      )
      return false
    }
  }
  // Each optional item gets its own deadline, leaving time for subsequent items and submission.
  const materialApi = (endpoint, options = {}) =>
    api(endpoint, { ...options, signal: materialSignal })
  const patch = body => materialApi(versionPath, { method: 'PATCH', body })
  await attemptMaterial('preserve summaries', async () => {
    const details = await materialApi(
      `developer/package-versions/${packageId}-${previous.version}/`
    )
    const translations = Object.fromEntries(
      Object.entries(details.translations || {})
        .filter(([, value]) => value.short_description)
        .map(([locale, value]) => [locale, { short_description: value.short_description }])
    )
    await patch({ translations })
  })
  if (readMaterial) {
    for (const locale of ['en', 'ru']) {
      for (const [field, source] of [
        ['short_description', 'summary'],
        ['long_description', 'description']
      ]) {
        await attemptMaterial(`${locale} ${field}`, async () => {
          const listing = JSON.parse(await readMaterial(`store/listings/opera/${locale}.json`))
          assert.ok(listing[source]?.trim(), `Missing Opera ${locale}.${source}`)
          await patch({ translations: { [locale]: { [field]: listing[source] } } })
        })
      }
    }
    for (const [field, source] of [
      ['support', 'support'],
      ['source_url', 'homepage']
    ]) {
      await attemptMaterial(field, async () => {
        const listing = JSON.parse(await readMaterial('store/listings/opera/en.json'))
        assert.ok(listing[source]?.trim(), `Missing Opera ${source}`)
        await patch({ [field]: listing[source] })
      })
    }
    await attemptMaterial('privacy policy', async () =>
      patch({
        privacy_policy: { full_text: (await readMaterial('store/PRIVACY.md')).toString(), url: '' }
      })
    )
    const image = async (file, endpoint, field) => {
      const data = await readMaterial(file)
      const id = await upload(data, path.basename(file), materialApi)
      await materialApi(endpoint, { method: 'PATCH', body: { [field]: { file_id: id } } })
    }
    await attemptMaterial('icon', () =>
      image('store/assets/shared/icon-64.png', versionPath, 'icon')
    )
    await attemptMaterial('promotion image', () =>
      image(
        'store/assets/shared/promo-opera.png',
        `developer/packages/${packageId}/`,
        'dev_promotional_image'
      )
    )
    const current = await attemptMaterial('read screenshots', () => materialApi(versionPath))
    let allUploaded = true
    for (let index = 1; index <= 3; index++) {
      const uploaded = await attemptMaterial(`screenshot ${index}`, async () => {
        await image(`store/assets/opera/en/0${index}.png`, versionPath, 'screenshots')
        return true
      })
      allUploaded &&= uploaded === true
    }
    if (allUploaded && current) {
      for (const screenshot of current.screenshots || []) {
        await attemptMaterial(`replace screenshot ${screenshot.id}`, () =>
          patch({ screenshots: { image_id: screenshot.id } })
        )
      }
    }
  }
  const submitted = await api(`${versionPath}submit_for_moderation/`, { method: 'POST' })
  assert.equal(submitted.version, version)
  assert.equal(submitted.submitted_for_moderation, true, 'Opera did not confirm submission')
  return `Opera ${tag}: submitted for moderation${warnings.length ? `; material warnings: ${warnings.length}` : ''}`
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2]
  assert.match(tag || '', /^v\d+\.\d+\.\d+$/)
  await reportStoreDashboard(
    'Opera Add-ons',
    `https://addons.opera.com/developer/package/${process.env.OPERA_PACKAGE_ID}/`
  )
  const file = `dist/release/MegaProxy-chromium-${tag}.zip`
  execFileSync('unzip', ['-t', file], { stdio: 'pipe' })
  const manifest = JSON.parse(
    execFileSync('unzip', ['-p', file, 'manifest.json'], { encoding: 'utf8' })
  )
  assert.equal(manifest.version, tag.slice(1), 'Archive version must match release tag')
  const result = await submitOperaAddon(tag, await readFile(file), {
    dryRun: process.env.OPERA_DRY_RUN === 'true',
    readMaterial: file => readStoreFile(tag, file)
  })
  console.log(result)
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${result}\n`)
  }
}
