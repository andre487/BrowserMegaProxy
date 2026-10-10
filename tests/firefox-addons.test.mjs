import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  checkFirefoxRelease,
  firefoxMetadata,
  syncFirefoxMaterials
} from '../scripts/firefox-addons.mjs'

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
    assert.equal(call.method, 'GET')
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

test('Firefox renews JWT and timeout after a slow 5xx response without leaking tokens', async t => {
  let now = 1000000
  t.mock.method(Date, 'now', () => now)
  const warnings = t.mock.method(console, 'warn', () => {})
  const tokens = []
  const signals = []
  const result = await checkFirefoxRelease('v0.1.1', manifest, {
    env,
    retryWait: async delay => {
      now += delay
    },
    request: async (url, options) => {
      const token = options.headers.Authorization.slice(4)
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'))
      assert.ok(claims.exp > now / 1000, 'JWT must still be valid when a retry starts')
      tokens.push(token)
      signals.push(options.signal)
      if (tokens.length === 1) {
        now += 59500
        return new Response(`Slow server failure: ${token}`, { status: 503 })
      }
      return new Response(JSON.stringify({ id: 123 }), {
        status: url.endsWith('accounts/profile/') ? 200 : 404
      })
    }
  })
  assert.equal(result.exists, false)
  assert.equal(new Set(tokens).size, tokens.length)
  assert.equal(new Set(signals).size, signals.length)
  assert.equal(warnings.mock.calls.length, 1)
  assert.ok(!warnings.mock.calls[0].arguments[0].includes(tokens[0]))
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
          support: 'https://example.org/support',
          screenshotCaptions: []
        })
      )
    }
    await write('source/store/PRIVACY.md', 'Privacy')
    await write('source/store/assets/shared/icon-128.png', 'png')
    await write(
      'source/store/REVIEWER-NOTES.md',
      await readFile(new URL('../store/REVIEWER-NOTES.md', import.meta.url), 'utf8')
    )
    await mkdir(`${directory}/dist/release`, { recursive: true })
    for (const [target, archive] of [
      ['extension', 'firefox'],
      ['source', 'source'],
      ['source', 'store-materials']
    ]) {
      execFileSync(
        'zip',
        ['-q', '-r', `${directory}/dist/release/MegaProxy-${archive}-v0.1.1.zip`, '.'],
        { cwd: `${directory}/${target}` }
      )
    }
    await write(
      'mock-api.mjs',
      `let created = false
    globalThis.fetch = async (url, options = {}) => {
      if (options.method === 'PATCH') created = true
      const ok = created || options.method !== 'GET' || url.endsWith('accounts/profile/')
      return { ok, status: ok ? 200 : 404, json: async () => ({id: 123, previews: []}) }
    }`
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

test('Firefox replaces listing, privacy, icon and localized previews; old previews survive an upload failure', async () => {
  const listings = Object.fromEntries(
    ['en', 'ru'].map(locale => [
      locale,
      {
        name: 'MegaProxy',
        summary: `Summary ${locale}`,
        description: `Description ${locale}`,
        homepage: 'https://example.org',
        support: 'https://example.org/issues',
        screenshotCaptions: [`Caption ${locale}`]
      }
    ])
  )
  const read = file =>
    Buffer.from(
      file.includes('/listings/')
        ? JSON.stringify(listings[file.includes('/ru.') ? 'ru' : 'en'])
        : file.endsWith('.png')
          ? 'png'
          : 'Privacy'
    )
  for (const fail of [false, true]) {
    const mock = api([
      {},
      {},
      {},
      { previews: [{ id: 9 }] },
      { id: 10 },
      {},
      fail ? { httpError: 400 } : { id: 11 },
      ...(fail ? [] : [{}, {}])
    ])
    const sync = syncFirefoxMaterials('v0.1.1', manifest, { env, request: mock.request, read })
    if (fail) {
      await assert.rejects(sync, /HTTP 400/)
    } else {
      await sync
    }
    assert.deepEqual(JSON.parse(mock.calls[0].body).description, {
      'en-US': 'Description en',
      ru: 'Description ru'
    })
    assert.ok(!('version' in JSON.parse(mock.calls[0].body)))
    assert.ok(mock.calls[1].url.endsWith('/eula_policy/'))
    assert.deepEqual(JSON.parse(mock.calls[1].body), { privacy_policy: { 'en-US': 'Privacy' } })
    assert.equal(mock.calls[2].body.get('icon').type, 'image/png')
    assert.equal(mock.calls[4].body.get('image').name, 'en-1.png')
    assert.equal(mock.calls[4].body.get('position'), '0')
    assert.deepEqual(JSON.parse(mock.calls[5].body), { caption: { 'en-US': 'Caption en' } })
    assert.equal(mock.calls[6].body.get('image').name, 'ru-1.png')
    assert.equal(mock.calls.filter(call => call.method === 'DELETE').length, fail ? 0 : 1)
    if (!fail) {
      assert.ok(mock.calls.at(-1).url.endsWith('/previews/9/'))
    }
  }
})
