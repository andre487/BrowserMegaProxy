import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkFirefoxRelease, firefoxMetadata } from '../scripts/firefox-addons.mjs'

const env = { WEB_EXT_API_KEY: 'user:123:4', WEB_EXT_API_SECRET: 'test-secret' }
const manifest = {
  version: '0.1.1',
  browser_specific_settings: { gecko: { id: 'browser-mega-proxy@andre487' } }
}
const addon = { guid: manifest.browser_specific_settings.gecko.id, authors: [{ id: 123 }] }

function api(responses) {
  const calls = []
  return {
    calls,
    request: async (url, options) => {
      calls.push({ url, ...options })
      assert.ok(responses.length, 'Unexpected AMO request')
      const body = responses.shift()
      return { ok: !body.httpError, status: body.httpError || 200, json: async () => body }
    }
  }
}

test('Firefox dry-run access checks use signed, short-lived JWTs and only read endpoints', async () => {
  const mock = api([{ id: 123 }, addon, { httpError: 404 }])
  assert.deepEqual(await checkFirefoxRelease('v0.1.1', manifest, { env, request: mock.request }), {
    exists: true,
    version: null
  })
  const tokens = new Set()
  for (const call of mock.calls) {
    assert.ok(call.url.startsWith('https://addons.mozilla.org/api/v5/'))
    assert.equal(call.method, undefined)
    assert.equal(call.redirect, 'error')
    const token = call.headers.Authorization.slice(4)
    tokens.add(token)
    const [header, payload, signature] = token.split('.')
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'HS256', typ: 'JWT' })
    const claims = JSON.parse(Buffer.from(payload, 'base64url'))
    assert.equal(claims.iss, env.WEB_EXT_API_KEY)
    assert.ok(claims.jti)
    assert.equal(claims.exp - claims.iat, 90)
    assert.equal(
      signature,
      createHmac('sha256', env.WEB_EXT_API_SECRET)
        .update(`${header}.${payload}`)
        .digest('base64url')
    )
  }
  assert.equal(tokens.size, 3)
})

test('Firefox access checks allow a new listing and report an already uploaded version', async () => {
  const missing = api([{ id: 123 }, { httpError: 404 }])
  assert.deepEqual(
    await checkFirefoxRelease('v0.1.1', manifest, { env, request: missing.request }),
    { exists: false, version: null }
  )
  assert.equal(missing.calls.length, 2)
  const version = { channel: 'listed', file: { status: 'unreviewed' }, source: 'source.zip' }
  const existing = api([{ id: 123 }, addon, version])
  assert.deepEqual(
    await checkFirefoxRelease('v0.1.1', manifest, { env, request: existing.request }),
    { exists: true, version }
  )
})

test('Firefox validates manifest and credentials before requests and rejects unauthorized or foreign listings', async () => {
  const noRequest = () => assert.fail('No API request expected')
  for (const args of [
    ['../tag', manifest, env],
    ['v0.1.0', manifest, env],
    ['v0.1.1', { ...manifest, browser_specific_settings: {} }, env],
    ['v0.1.1', manifest, {}]
  ]) {
    await assert.rejects(
      checkFirefoxRelease(args[0], args[1], { env: args[2], request: noRequest })
    )
  }
  for (const responses of [
    [{ httpError: 401 }],
    [{ id: 123 }, { httpError: 403 }],
    [{ id: 456 }, addon],
    [{ id: 123 }, { ...addon, guid: 'foreign' }]
  ]) {
    const mock = api(responses)
    await assert.rejects(checkFirefoxRelease('v0.1.1', manifest, { env, request: mock.request }))
  }
})

test('Firefox initial metadata is localized; updates preserve existing listing fields', () => {
  const listings = Object.fromEntries(
    ['en', 'ru'].map(locale => [
      locale,
      {
        name: `Name ${locale}`,
        summary: `Summary ${locale}`,
        description: `Description ${locale}`,
        homepage: 'https://example.org',
        support: 'https://example.org/support'
      }
    ])
  )
  const created = firefoxMetadata(listings, 'Privacy', 'Reviewer notes', false)
  assert.deepEqual(created.summary, { 'en-US': 'Summary en', ru: 'Summary ru' })
  assert.deepEqual(created.categories, { firefox: ['other'], android: ['other'] })
  assert.equal(created.version.license, 'MIT')
  assert.ok(created.version.approval_notes.includes('npm ci && npm run build'))
  assert.deepEqual(created.privacy_policy, { 'en-US': 'Privacy' })
  const updated = firefoxMetadata(listings, 'Privacy', 'Reviewer notes', true)
  assert.deepEqual(Object.keys(updated), ['version'])
  assert.throws(() => firefoxMetadata({ en: listings.en, ru: {} }, 'Privacy', 'Notes', false))
})

test('Firefox reviewer metadata respects the AMO limit for new listings and updates', async () => {
  const reviewerNotes = await readFile(
    new URL('../store/REVIEWER-NOTES.md', import.meta.url),
    'utf8'
  )
  const listings = Object.fromEntries(
    ['en', 'ru'].map(locale => [
      locale,
      Object.fromEntries(
        ['name', 'summary', 'description', 'homepage', 'support'].map(field => [field, field])
      )
    ])
  )
  const overhead = firefoxMetadata({}, '', '', true).version.approval_notes.length
  for (const exists of [false, true]) {
    const atLimit = 'x'.repeat(3000 - overhead)
    const unchanged = firefoxMetadata(listings, '', atLimit, exists).version.approval_notes
    assert.equal(unchanged.length, 3000)
    assert.ok(unchanged.startsWith(atLimit))
    for (const notes of [atLimit + 'x', reviewerNotes, '😀'.repeat(3000)]) {
      const metadata = firefoxMetadata(listings, '', notes, exists)
      assert.ok(metadata.version.approval_notes.length <= 3000)
      assert.match(metadata.version.approval_notes, /store\/REVIEWER-NOTES\.md/)
      assert.match(metadata.version.approval_notes, /store\/PERMISSIONS\.md/)
      assert.match(metadata.version.approval_notes, /npm ci && npm run build/)
    }
  }
})

test('Firefox CLI validates released archives and delegates submission with source; dry run never invokes web-ext', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mega-amo-'))
  try {
    const write = async (file, value) => {
      const target = path.join(directory, file)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, value)
    }
    await write('extension/manifest.json', JSON.stringify(manifest))
    await write('source/package.json', JSON.stringify({ version: '0.1.1' }))
    for (const locale of ['en', 'ru']) {
      await write(
        `source/store/listings/firefox/${locale}.json`,
        JSON.stringify({
          name: 'MegaProxy',
          summary: 'Proxy manager',
          description: 'Manage proxies',
          homepage: 'https://example.org',
          support: 'https://example.org/support'
        })
      )
    }
    await write('source/store/PRIVACY.md', 'Privacy')
    await write(
      'source/store/REVIEWER-NOTES.md',
      await readFile(new URL('../store/REVIEWER-NOTES.md', import.meta.url), 'utf8')
    )
    await mkdir(`${directory}/dist/release`, { recursive: true })
    for (const [target, archive] of [
      ['extension', 'firefox'],
      ['source', 'source']
    ]) {
      execFileSync(
        'zip',
        ['-q', '-r', `${directory}/dist/release/MegaProxy-${archive}-v0.1.1.zip`, '.'],
        { cwd: `${directory}/${target}` }
      )
    }
    await write(
      'mock-api.mjs',
      `globalThis.fetch = async url => ({
      ok: url.endsWith('accounts/profile/'),
      status: url.endsWith('accounts/profile/') ? 200 : 404,
      json: async () => ({id: 123})
    })`
    )
    await write('bin/npx', '#!/bin/sh\nprintf "%s\\n" "$@" > "$AMO_CAPTURE"\n')
    await chmod(`${directory}/bin/npx`, 0o755)
    const capture = `${directory}/command.txt`
    const run = dryRun =>
      execFileSync(
        process.execPath,
        [
          '--import',
          `${directory}/mock-api.mjs`,
          fileURLToPath(new URL('../scripts/firefox-addons.mjs', import.meta.url)),
          'v0.1.1'
        ],
        {
          cwd: directory,
          encoding: 'utf8',
          env: {
            ...process.env,
            ...env,
            PATH: `${directory}/bin:${process.env.PATH}`,
            AMO_CAPTURE: capture,
            AMO_DRY_RUN: String(dryRun),
            GITHUB_STEP_SUMMARY: `${directory}/summary.md`
          }
        }
      )
    assert.match(run(false), /submitted to AMO/)
    const command = await readFile(capture, 'utf8')
    assert.match(command, /web-ext@10\.7\.0\nsign\n--channel\nlisted/)
    assert.match(command, /--upload-source-code\ndist\/release\/MegaProxy-source-v0\.1\.1\.zip/)
    assert.match(command, /--approval-timeout\n0/)
    assert.ok(!command.includes(env.WEB_EXT_API_SECRET))
    const metadata = JSON.parse(await readFile(`${directory}/dist/amo-metadata.json`, 'utf8'))
    assert.equal(metadata.version.license, 'MIT')
    assert.ok(metadata.version.approval_notes.length <= 3000)
    assert.match(metadata.version.approval_notes, /store\/REVIEWER-NOTES\.md/)
    await rm(capture)
    assert.match(run(true), /dry run passed/)
    await assert.rejects(readFile(capture), { code: 'ENOENT' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
