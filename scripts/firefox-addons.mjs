import { requestWithRetry } from './http-request.mjs'
import { readStoreFile, reportStoreDashboard } from './store-materials.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateVersion } from './release.mjs'

function firefoxApi({ env = process.env, request = fetch, retryWait } = {}) {
  const base = 'https://addons.mozilla.org/api/v5/'
  return async (endpoint, { method = 'GET', body, allowMissing = false } = {}) => {
    const now = Math.floor(Date.now() / 1000)
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
    const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
      iss: env.WEB_EXT_API_KEY,
      jti: randomUUID(),
      iat: now - 30,
      exp: now + 60
    })}`
    const signature = createHmac('sha256', env.WEB_EXT_API_SECRET)
      .update(unsigned)
      .digest('base64url')
    const response = await requestWithRetry(
      (url, options) => request(url, { ...options, signal: AbortSignal.timeout(60000) }),
      `${base}${endpoint}`,
      {
        redirect: 'error',
        method,
        headers: {
          Authorization: `JWT ${unsigned}.${signature}`,
          ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {})
        },
        body:
          body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body)
      },
      {
        secrets: [env.WEB_EXT_API_KEY, env.WEB_EXT_API_SECRET, `${unsigned}.${signature}`],
        wait: retryWait
      }
    )
    if (allowMissing && response.status === 404) {
      return null
    }
    if (!response.ok) {
      throw await globalThis.MegaErrors.httpError(
        response,
        `AMO ${method} ${endpoint} failed: HTTP ${response.status}`,
        [env.WEB_EXT_API_KEY, env.WEB_EXT_API_SECRET, `${unsigned}.${signature}`]
      )
    }
    return response.status === 204 ? null : response.json()
  }
}

export async function checkFirefoxRelease(
  tag,
  manifest,
  { env = process.env, request = fetch, retryWait } = {}
) {
  assert.match(tag || '', /^v\d+\.\d+\.\d+$/)
  validateVersion(tag.slice(1))
  assert.equal(manifest.version, tag.slice(1), 'Archive version must match release tag')
  assert.equal(manifest.browser_specific_settings?.gecko?.id, 'browser-mega-proxy@andre487')
  assert.ok(env.WEB_EXT_API_KEY?.trim(), 'Configure AMO_JWT_ISSUER')
  assert.ok(env.WEB_EXT_API_SECRET?.trim(), 'Configure AMO_JWT_SECRET')
  const api = firefoxApi({ env, request, retryWait })
  const get = (endpoint, allowMissing = false) => api(endpoint, { allowMissing })
  const profile = await get('accounts/profile/')
  assert.ok(Number.isInteger(profile.id), 'Invalid AMO account response')
  const addonPath = `addons/addon/${encodeURIComponent(manifest.browser_specific_settings.gecko.id)}/`
  const addon = await get(addonPath, true)
  if (!addon) {
    return { exists: false, version: null }
  }
  assert.equal(addon.guid, manifest.browser_specific_settings.gecko.id)
  assert.ok(
    addon.authors?.some(author => author.id === profile.id),
    'AMO account must be an author of MegaProxy'
  )
  return { exists: true, version: await get(`${addonPath}versions/${tag.slice(1)}/`, true) }
}

export function firefoxMetadata(listings, privacy, reviewerNotes, exists) {
  const buildNotes =
    'Build from the attached source archive with Node.js 22+: npm ci && npm run build. The Firefox package is dist/firefox. Uploads use the listed channel.'
  const approvalNotes = `${reviewerNotes}\n\n${buildNotes}`
  const version = {
    license: 'MIT',
    approval_notes:
      approvalNotes.length <= 3000
        ? approvalNotes
        : `Full review steps and permission justifications are in store/REVIEWER-NOTES.md and store/PERMISSIONS.md in the attached source archive.\n\n${buildNotes}`
  }
  if (exists) {
    return { version }
  }
  const translated = field =>
    Object.fromEntries(
      [
        ['en-US', 'en'],
        ['ru', 'ru']
      ].map(([locale, language]) => {
        assert.ok(listings[language][field]?.trim(), `Missing Firefox listing ${language}.${field}`)
        return [locale, listings[language][field]]
      })
    )
  return {
    default_locale: 'en-US',
    name: translated('name'),
    summary: translated('summary'),
    description: translated('description'),
    homepage: translated('homepage'),
    support_url: translated('support'),
    privacy_policy: { 'en-US': privacy },
    categories: { firefox: ['other'], android: ['other'] },
    version
  }
}

export async function syncFirefoxMaterials(
  tag,
  manifest,
  { read = file => readStoreFile(tag, file), ...options } = {}
) {
  const api = firefoxApi(options)
  const endpoint = `addons/addon/${encodeURIComponent(manifest.browser_specific_settings.gecko.id)}/`
  const listings = Object.fromEntries(
    ['en', 'ru'].map(locale => [
      locale,
      JSON.parse(read(`store/listings/firefox/${locale}.json`).toString())
    ])
  )
  const { version, privacy_policy, ...metadata } = firefoxMetadata(
    listings,
    read('store/PRIVACY.md').toString(),
    '',
    false
  )
  void version
  await api(endpoint, { method: 'PATCH', body: metadata })
  await api(`${endpoint}eula_policy/`, { method: 'PATCH', body: { privacy_policy } })
  const icon = new FormData()
  icon.append(
    'icon',
    new Blob([read('store/assets/shared/icon-128.png')], { type: 'image/png' }),
    'icon.png'
  )
  await api(endpoint, { method: 'PATCH', body: icon })
  const previous = (await api(endpoint)).previews || []
  // Keep existing screenshots until every replacement and its captions are accepted.
  for (const language of ['en', 'ru']) {
    for (let index = 0; index < listings[language].screenshotCaptions.length; index++) {
      const file = `store/assets/firefox/${language}/0${index + 1}.png`
      const form = new FormData()
      form.append(
        'image',
        new Blob([read(file)], { type: 'image/png' }),
        `${language}-${index + 1}.png`
      )
      form.append('position', String((language === 'en' ? 0 : 5) + index))
      const preview = await api(`${endpoint}previews/`, { method: 'POST', body: form })
      assert.ok(Number.isInteger(preview.id), 'AMO preview response missing ID')
      await api(`${endpoint}previews/${preview.id}/`, {
        method: 'PATCH',
        body: {
          caption: {
            [language === 'en' ? 'en-US' : 'ru']: listings[language].screenshotCaptions[index]
          }
        }
      })
    }
  }
  for (const preview of previous) {
    await api(`${endpoint}previews/${preview.id}/`, { method: 'DELETE' })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2]
  assert.match(tag || '', /^v\d+\.\d+\.\d+$/)
  await reportStoreDashboard('Firefox Add-ons', 'https://addons.mozilla.org/developers/addons')
  const archive = `dist/release/MegaProxy-firefox-${tag}.zip`
  const source = `dist/release/MegaProxy-source-${tag}.zip`
  for (const file of [archive, source, `dist/release/MegaProxy-store-materials-${tag}.zip`]) {
    execFileSync('unzip', ['-t', file], { stdio: 'pipe' })
  }
  const fromSource = file => execFileSync('unzip', ['-p', source, file], { encoding: 'utf8' })
  assert.equal(JSON.parse(fromSource('package.json')).version, tag.slice(1))
  const manifest = JSON.parse(
    execFileSync('unzip', ['-p', archive, 'manifest.json'], { encoding: 'utf8' })
  )
  const state = await checkFirefoxRelease(tag, manifest)
  const metadata = firefoxMetadata(
    Object.fromEntries(
      ['en', 'ru'].map(locale => [
        locale,
        JSON.parse(readStoreFile(tag, `store/listings/firefox/${locale}.json`).toString())
      ])
    ),
    readStoreFile(tag, 'store/PRIVACY.md').toString(),
    fromSource('store/REVIEWER-NOTES.md'),
    state.exists
  )
  let result
  if (process.env.AMO_DRY_RUN === 'true') {
    result = `Firefox ${tag}: dry run passed (authenticated; no upload or submission; ${state.exists ? 'existing listing' : 'initial listing required'})`
  } else if (state.version) {
    assert.equal(
      state.version.channel,
      'listed',
      'Existing Firefox version is not listed; check AMO dashboard'
    )
    assert.ok(
      ['public', 'unreviewed'].includes(state.version.file?.status),
      'Existing Firefox version needs attention in AMO dashboard'
    )
    assert.ok(
      state.version.source,
      'Existing Firefox version is missing source; attach it in AMO dashboard'
    )
    result = `Firefox ${tag}: already submitted (${state.version.file.status})`
  } else {
    const directory = 'dist/amo-extension'
    await rm(directory, { recursive: true, force: true })
    await mkdir(directory, { recursive: true })
    execFileSync('unzip', ['-q', archive, '-d', directory])
    await writeFile('dist/amo-metadata.json', JSON.stringify(metadata))
    execFileSync(
      'npx',
      [
        '--yes',
        'web-ext@10.7.0',
        'sign',
        '--channel',
        'listed',
        '--source-dir',
        directory,
        '--upload-source-code',
        source,
        '--amo-metadata',
        'dist/amo-metadata.json',
        '--artifacts-dir',
        'dist/amo-artifacts',
        '--approval-timeout',
        '0',
        '--timeout',
        '180000',
        '--no-input',
        '--no-config-discovery'
      ],
      { stdio: 'inherit', timeout: 600000 }
    )
    result = `Firefox ${tag}: submitted to AMO for review`
  }
  if (process.env.AMO_DRY_RUN !== 'true') {
    await syncFirefoxMaterials(tag, manifest)
    result += '; listing, privacy, icon and screenshots updated'
  }
  console.log(result)
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${result}\n`)
  }
}
