import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateVersion } from './release.mjs'

export async function checkFirefoxRelease(
  tag,
  manifest,
  { env = process.env, request = fetch } = {}
) {
  assert.match(tag || '', /^v\d+\.\d+\.\d+$/)
  validateVersion(tag.slice(1))
  assert.equal(manifest.version, tag.slice(1), 'Archive version must match release tag')
  assert.equal(manifest.browser_specific_settings?.gecko?.id, 'browser-mega-proxy@andre487')
  assert.ok(env.WEB_EXT_API_KEY?.trim(), 'Configure AMO_JWT_ISSUER')
  assert.ok(env.WEB_EXT_API_SECRET?.trim(), 'Configure AMO_JWT_SECRET')
  const base = 'https://addons.mozilla.org/api/v5/'
  const get = async (endpoint, allowMissing = false) => {
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
    const response = await request(`${base}${endpoint}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(60000),
      headers: { Authorization: `JWT ${unsigned}.${signature}` }
    })
    if (allowMissing && response.status === 404) {
      return null
    }
    // API responses and JWTs must not be printed to release logs.
    assert.ok(response.ok, `AMO access check failed: HTTP ${response.status}`)
    return response.json()
  }
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
  const version = {
    license: 'MIT',
    approval_notes: `${reviewerNotes}\n\nBuild from the attached source archive with Node.js 22+: npm ci && npm run build. The Firefox package is dist/firefox. Uploads use the listed channel.`
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2]
  assert.match(tag || '', /^v\d+\.\d+\.\d+$/)
  const archive = `dist/release/MegaProxy-firefox-${tag}.zip`
  const source = `dist/release/MegaProxy-source-${tag}.zip`
  for (const file of [archive, source]) {
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
        JSON.parse(fromSource(`store/listings/firefox/${locale}.json`))
      ])
    ),
    fromSource('store/PRIVACY.md'),
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
  console.log(result)
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${result}\n`)
  }
}
