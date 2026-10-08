import assert from 'node:assert/strict'
import test from 'node:test'
import { submitOperaAddon } from '../scripts/opera-addons.mjs'

const env = { OPERA_PACKAGE_ID: '123', OPERA_SESSION_ID: 'private-session' }
const addon = { id: 123, is_editable: true, versions: [{ version: '0.1.0' }] }
const details = {
  translations: { en: { short_description: 'Proxy manager' }, ru: { short_description: 'Прокси' } }
}
const submitted = { version: '0.1.1', submitted_for_moderation: true }

function api(responses) {
  const calls = []
  return {
    calls,
    request: async (url, options) => {
      calls.push({ url, ...options })
      assert.ok(responses.length, 'Unexpected Opera request')
      const body = responses.shift()
      return {
        ok: !body?.httpError,
        status: body?.httpError || 200,
        json: async () => body
      }
    }
  }
}

test('Opera dry run authenticates and checks metadata without any write requests', async () => {
  const mock = api([addon, details])
  assert.match(
    await submitOperaAddon('v0.1.1', Buffer.from('zip'), {
      env,
      request: mock.request,
      dryRun: true
    }),
    /dry run passed/
  )
  assert.equal(mock.calls.length, 2)
  assert.ok(mock.calls.every(call => call.method === 'GET' && call.redirect === 'error'))
  assert.match(mock.calls[0].headers.Cookie, /^sessionid=private-session; csrftoken=[a-f0-9]{32}$/)
  assert.ok(!mock.calls[0].url.includes(env.OPERA_SESSION_ID))
})

test('Opera chunks the archive, retries delayed validation and preserves localized summaries before submission', async () => {
  const chunkSize = 1024 * 1024
  const archive = Buffer.alloc(chunkSize + 3, 1)
  const mock = api([
    addon,
    details,
    null,
    null,
    { httpError: 404 },
    { version: '0.1.1' },
    {},
    submitted
  ])
  let waits = 0
  assert.match(
    await submitOperaAddon('v0.1.1', archive, {
      env,
      request: mock.request,
      wait: async delay => {
        assert.equal(delay, 5000)
        waits++
      }
    }),
    /submitted for moderation/
  )
  assert.equal(waits, 1)
  const uploads = mock.calls.filter(call => call.url.endsWith('/file-upload/'))
  assert.equal(uploads.length, 2)
  for (let i = 0; i < uploads.length; i++) {
    const form = uploads[i].body
    assert.equal(form.get('flowChunkNumber'), String(i + 1))
    assert.equal(form.get('flowTotalChunks'), '2')
    assert.equal(form.get('file').size, i ? 3 : chunkSize)
    assert.deepEqual(
      Buffer.from(await form.get('file').arrayBuffer()),
      archive.subarray(i * chunkSize, (i + 1) * chunkSize)
    )
  }
  const validated = JSON.parse(mock.calls[5].body)
  assert.equal(validated.metadata_from, '0.1.0')
  assert.equal(validated.file_id, uploads[0].body.get('flowIdentifier'))
  assert.deepEqual(JSON.parse(mock.calls[6].body), details)
  assert.equal(mock.calls[6].method, 'PATCH')
  assert.match(mock.calls[7].url, /123-0\.1\.1\/submit_for_moderation\/$/)
  assert.equal(mock.calls[7].method, 'POST')
})

test('Opera recovery reuses existing versions and skips a completed submission', async () => {
  for (const alreadySubmitted of [true, false]) {
    const mock = api([
      {
        ...addon,
        versions: [
          { version: '0.1.1', submitted_for_moderation: alreadySubmitted },
          ...addon.versions
        ]
      },
      details,
      ...(alreadySubmitted ? [] : [{}, submitted])
    ])
    await submitOperaAddon('v0.1.1', Buffer.from('zip'), { env, request: mock.request })
    assert.ok(!mock.calls.some(call => call.url.includes('file-upload')))
    assert.equal(mock.calls.length, alreadySubmitted ? 2 : 4)
  }
})

test('Opera rejects invalid settings and fails before submission on authentication, metadata or upload errors', async () => {
  const noRequest = () => assert.fail('Must not contact Opera')
  for (const settings of [
    {},
    { ...env, OPERA_PACKAGE_ID: '../123' },
    { ...env, OPERA_SESSION_ID: 'bad;cookie' }
  ]) {
    await assert.rejects(
      submitOperaAddon('v0.1.1', Buffer.from('zip'), { env: settings, request: noRequest })
    )
  }
  await assert.rejects(submitOperaAddon('../tag', Buffer.from('zip'), { env, request: noRequest }))
  const cases = [
    [{ httpError: 403 }],
    [{ detail: 'denied' }],
    [{ ...addon, is_editable: false }],
    [{ ...addon, versions: [] }],
    [addon, { translations: {} }],
    [addon, details, { httpError: 401 }],
    [addon, details, null, { version: '0.1.2' }],
    [addon, details, null, { version: '0.1.1' }, { httpError: 500 }]
  ]
  for (const responses of cases) {
    const mock = api(responses)
    await assert.rejects(
      submitOperaAddon('v0.1.1', Buffer.from('zip'), { env, request: mock.request })
    )
    assert.ok(!mock.calls.some(call => call.url.includes('submit_for_moderation')))
  }
  const mock = api([
    addon,
    details,
    null,
    { version: '0.1.1' },
    {},
    { version: '0.1.1', submitted_for_moderation: false }
  ])
  await assert.rejects(
    submitOperaAddon('v0.1.1', Buffer.from('zip'), { env, request: mock.request }),
    /did not confirm/
  )
})
