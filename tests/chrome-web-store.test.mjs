import assert from 'node:assert/strict'
import test from 'node:test'
import { publishChromeWebStore } from '../scripts/chrome-web-store.mjs'

const env = {
  CWS_PUBLISHER_ID: 'publisher',
  CWS_EXTENSION_ID: 'kfilelfnldddoncicbampiojjjcpbigo',
  CWS_CLIENT_ID: 'client',
  CWS_CLIENT_SECRET: 'secret',
  CWS_REFRESH_TOKEN: 'refresh'
}
const base = `https://chromewebstore.googleapis.com/v2/publishers/publisher/items/${env.CWS_EXTENSION_ID}`
const archive = Buffer.from('test archive')

function api(responses) {
  const calls = []
  return {
    calls,
    request: async (url, options) => {
      calls.push({ url, ...options })
      assert.ok(responses.length, `Unexpected request to ${url}`)
      const body = responses.shift()
      return { ok: true, json: async () => body }
    }
  }
}

test('Chrome submission refreshes OAuth, uploads the release ZIP and waits before publishing', async () => {
  const mock = api([
    { access_token: 'token' },
    {},
    { uploadState: 'IN_PROGRESS' },
    { lastAsyncUploadState: 'SUCCEEDED' },
    { state: 'PENDING_REVIEW' }
  ])
  let waits = 0
  const result = await publishChromeWebStore('v0.1.1', archive, {
    env,
    request: mock.request,
    wait: async delay => {
      assert.equal(delay, 5000)
      waits++
    }
  })
  assert.match(result, /PENDING_REVIEW/)
  assert.equal(waits, 1)
  assert.deepEqual(
    mock.calls.map(call => call.url),
    [
      'https://oauth2.googleapis.com/token',
      `${base}:fetchStatus`,
      `${base.replace('/v2/', '/upload/v2/')}:upload`,
      `${base}:fetchStatus`,
      `${base}:publish`
    ]
  )
  assert.deepEqual(Object.fromEntries(mock.calls[0].body), {
    grant_type: 'refresh_token',
    client_id: 'client',
    client_secret: 'secret',
    refresh_token: 'refresh'
  })
  assert.equal(mock.calls[2].method, 'POST')
  assert.equal(mock.calls[2].body, archive)
  assert.equal(mock.calls[2].headers.Authorization, 'Bearer token')
  assert.deepEqual(JSON.parse(mock.calls[4].body), { publishType: 'DEFAULT_PUBLISH' })
})

test('dry run authenticates and reads status without uploading or submitting', async () => {
  const mock = api([{ access_token: 'token' }, {}])
  assert.match(
    await publishChromeWebStore('v0.1.1', archive, { env, request: mock.request, dryRun: true }),
    /dry run passed/
  )
  assert.equal(mock.calls.length, 2)
  assert.equal(mock.calls[1].url, `${base}:fetchStatus`)
  assert.equal(mock.calls[1].method, undefined)
})

test('recovery skips matching pending or published versions, but uploads a new version', async () => {
  for (const state of ['PENDING_REVIEW', 'PUBLISHED', 'PUBLISHED_TO_TESTERS']) {
    const revision = { state, distributionChannels: [{ crxVersion: '0.1.1' }] }
    const mock = api([
      { access_token: 'token' },
      {
        [state === 'PENDING_REVIEW'
          ? 'submittedItemRevisionStatus'
          : 'publishedItemRevisionStatus']: revision
      }
    ])
    assert.match(
      await publishChromeWebStore('v0.1.1', archive, { env, request: mock.request }),
      /already submitted/
    )
    assert.equal(mock.calls.length, 2)
  }
  const mock = api([
    { access_token: 'token' },
    {
      publishedItemRevisionStatus: {
        state: 'PUBLISHED',
        distributionChannels: [{ crxVersion: '0.1.0' }]
      }
    },
    { uploadState: 'SUCCEEDED' },
    { state: 'PENDING_REVIEW' }
  ])
  await publishChromeWebStore('v0.1.1', archive, { env, request: mock.request })
  assert.equal(mock.calls.length, 4)
})

test('invalid configuration, HTTP errors and failed or timed-out uploads stop submission', async () => {
  const unexpected = () => assert.fail('Must not call API')
  await assert.rejects(
    publishChromeWebStore('v0.1.1', archive, { env: {}, request: unexpected }),
    /CWS_PUBLISHER_ID/
  )
  await assert.rejects(publishChromeWebStore('v0.0.0', archive, { env, request: unexpected }))
  await assert.rejects(publishChromeWebStore('../tag', archive, { env, request: unexpected }))
  await assert.rejects(
    publishChromeWebStore('v0.1.1', archive, {
      env,
      request: async () => ({ ok: false, status: 401 })
    }),
    /HTTP 401/
  )
  const noToken = api([{}])
  await assert.rejects(
    publishChromeWebStore('v0.1.1', archive, { env, request: noToken.request }),
    /missing access token/
  )
  for (const state of ['FAILED', 'IN_PROGRESS', undefined]) {
    const mock = api([
      { access_token: 'token' },
      {},
      { uploadState: state },
      ...Array.from({ length: 30 }, () => ({ lastAsyncUploadState: 'IN_PROGRESS' }))
    ])
    await assert.rejects(
      publishChromeWebStore('v0.1.1', archive, {
        env,
        request: mock.request,
        wait: async () => {}
      }),
      /upload did not succeed/
    )
    assert.ok(!mock.calls.some(call => call.url.endsWith(':publish')))
  }
  const rejected = api([
    { access_token: 'token' },
    {},
    { uploadState: 'SUCCEEDED' },
    { state: 'REJECTED' }
  ])
  await assert.rejects(
    publishChromeWebStore('v0.1.1', archive, { env, request: rejected.request }),
    /Unexpected.*REJECTED/
  )
})

test('Chrome retries receive fresh timeout signals', async () => {
  const signals = []
  const waits = []
  await publishChromeWebStore('v0.1.1', archive, {
    env,
    dryRun: true,
    retryWait: async delay => waits.push(delay),
    request: async (url, options) => {
      if (url.includes('oauth2')) {
        signals.push(options.signal)
        assert.equal(options.signal.aborted, false)
        if (signals.length === 1) {
          return new Response('Unavailable', { status: 503 })
        }
        return new Response(JSON.stringify({ access_token: 'token' }))
      }
      return new Response('{}')
    }
  })
  assert.equal(signals.length, 2)
  assert.notEqual(signals[0], signals[1])
  assert.deepEqual(waits, [1000])
})
