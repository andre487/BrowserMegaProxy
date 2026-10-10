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
    null,
    null,
    { httpError: 404 },
    { version: '0.1.1' },
    details,
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
  const validated = JSON.parse(mock.calls[4].body)
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
      ...(alreadySubmitted ? [] : [details, {}, submitted])
    ])
    await submitOperaAddon('v0.1.1', Buffer.from('zip'), { env, request: mock.request })
    assert.ok(!mock.calls.some(call => call.url.includes('file-upload')))
    assert.equal(mock.calls.length, alreadySubmitted ? 1 : 4)
  }
})

test('Opera retries version creation with exponential backoff and a fresh timeout', async () => {
  const mock = api([
    addon,
    null,
    ...Array.from({ length: 5 }, () => ({ httpError: 500 })),
    { version: '0.1.1' },
    details,
    {},
    submitted
  ])
  const waits = []
  await submitOperaAddon('v0.1.1', Buffer.from('zip'), {
    env,
    request: mock.request,
    retryWait: async ms => waits.push(ms)
  })
  assert.deepEqual(waits, [10000, 20000, 40000, 80000, 160000])
  const attempts = mock.calls.filter(call => call.url.endsWith('?package_id=123'))
  assert.equal(attempts.length, 6)
  assert.equal(new Set(attempts.map(call => call.signal)).size, 6)
  assert.ok(attempts.every(call => !call.signal.aborted && call.body === attempts[0].body))
})

test('Opera rejects invalid settings and fails before submission on authentication or upload errors', async () => {
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
    [addon, { httpError: 401 }],
    [addon, null, { version: '0.1.2' }],
    [addon, null, { httpError: 403 }]
  ]
  for (const responses of cases) {
    const mock = api(responses)
    await assert.rejects(
      submitOperaAddon('v0.1.1', Buffer.from('zip'), {
        env,
        request: mock.request,
        retryWait: async () => {}
      })
    )
    assert.ok(!mock.calls.some(call => call.url.includes('submit_for_moderation')))
  }
  const mock = api([
    addon,
    null,
    { version: '0.1.1' },
    details,
    {},
    { version: '0.1.1', submitted_for_moderation: false }
  ])
  await assert.rejects(
    submitOperaAddon('v0.1.1', Buffer.from('zip'), { env, request: mock.request }),
    /did not confirm/
  )
})

test('Opera updates each material independently and still submits after individual or total failures', async () => {
  const listing = {
    summary: 'New summary',
    description: 'New description',
    homepage: 'https://example.org',
    support: 'https://example.org/issues'
  }
  const targets = [
    'en short_description',
    'en long_description',
    'ru short_description',
    'ru long_description',
    'support',
    'source_url',
    'privacy_policy',
    'icon',
    'dev_promotional_image',
    'read screenshots',
    '01.png',
    '02.png',
    '03.png',
    'all',
    'missing archive',
    null
  ]
  for (const failure of targets) {
    const calls = []
    const warnings = []
    const reads = []
    const result = await submitOperaAddon('v0.1.1', Buffer.from('zip'), {
      env,
      retryWait: async () => {},
      warn: message => warnings.push(message),
      readMaterial: file => {
        reads.push(file)
        if (failure === 'missing archive') {
          throw new Error(`Missing archive ${env.OPERA_SESSION_ID}`)
        }
        return Buffer.from(file.includes('/listings/') ? JSON.stringify(listing) : 'png')
      },
      request: async (url, options) => {
        calls.push({ url, ...options })
        let body = {}
        let target
        if (options.method === 'GET' && url.endsWith('/packages/123/')) {
          body = addon
        } else if (url.endsWith('?package_id=123')) {
          body = { version: '0.1.1' }
        } else if (url.includes('submit_for_moderation')) {
          body = submitted
        } else if (options.method === 'GET' && url.endsWith('/123-0.1.0/')) {
          body = details
        } else if (options.method === 'GET') {
          body = { screenshots: [{ id: 42 }] }
          target = 'read screenshots'
        } else if (options.body instanceof FormData) {
          const filename = options.body.get('file').name
          if (filename.endsWith('.png')) {
            target = filename
          }
        } else if (options.method === 'PATCH') {
          const data = JSON.parse(options.body)
          target = Object.keys(data)[0]
          if (data.translations) {
            const locale = Object.keys(data.translations)[0]
            target = `${locale} ${Object.keys(data.translations[locale])[0]}`
          }
        }
        const failed = !!target && (failure === target || failure === 'all')
        return { ok: !failed, status: failed ? 400 : 200, json: async () => body }
      }
    })
    assert.match(result, /submitted for moderation/)
    assert.ok(calls.at(-1).url.includes('submit_for_moderation'))
    assert.equal(reads.filter(file => file.includes('/listings/')).length, 6)
    assert.ok(reads.includes('store/assets/shared/icon-64.png'))
    assert.ok(reads.includes('store/assets/shared/promo-opera.png'))
    for (let i = 1; i <= 3; i++) {
      assert.ok(reads.includes(`store/assets/opera/en/0${i}.png`))
    }
    assert.equal(warnings.length > 0, failure !== null)
    assert.ok(
      warnings.every(
        message => message.startsWith('::warning') && !message.includes(env.OPERA_SESSION_ID)
      )
    )
    const deletes = calls.filter(
      call => call.method === 'PATCH' && JSON.parse(call.body).screenshots?.image_id
    )
    assert.equal(
      deletes.length,
      ['01.png', '02.png', '03.png', 'all', 'missing archive', 'read screenshots'].includes(failure)
        ? 0
        : 1
    )
    if (failure === null) {
      const icon = calls.find(
        call => call.body instanceof FormData && call.body.get('file').name === 'icon-64.png'
      )
      const attached = calls.find(call => call.method === 'PATCH' && JSON.parse(call.body).icon)
      assert.equal(JSON.parse(attached.body).icon.file_id, icon.body.get('flowIdentifier'))
    }
  }
})
