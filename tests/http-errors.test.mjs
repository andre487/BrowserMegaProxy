import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { requestWithRetry } from '../scripts/http-request.mjs'
import { publishChromeWebStore } from '../scripts/chrome-web-store.mjs'
import { checkFirefoxRelease } from '../scripts/firefox-addons.mjs'
import { generateNotes } from '../scripts/release.mjs'
import '../extension/subscription-catalog.js'
import '../extension/subscriptions.js'

const secret = 'private-test-secret'
const failing = (url, options) =>
  new Response(
    JSON.stringify({
      error: 'upstream processing failed',
      echoed: secret,
      authorization: options.headers?.Authorization || options.headers?.Cookie
    }),
    { status: 503 }
  )

test('all release API integrations retain 5xx response diagnostics without credentials', async () => {
  for (const invoke of [
    () =>
      publishChromeWebStore('v1.0.0', Buffer.from('zip'), {
        env: {
          CWS_PUBLISHER_ID: 'publisher',
          CWS_EXTENSION_ID: 'extension',
          CWS_CLIENT_ID: 'client',
          CWS_CLIENT_SECRET: secret,
          CWS_REFRESH_TOKEN: secret
        },
        retryWait: async () => {},
        request: failing
      }),
    () =>
      checkFirefoxRelease(
        'v1.0.0',
        {
          version: '1.0.0',
          browser_specific_settings: { gecko: { id: 'browser-mega-proxy@andre487' } }
        },
        {
          env: { WEB_EXT_API_KEY: 'key', WEB_EXT_API_SECRET: secret },
          retryWait: async () => {},
          request: failing
        }
      ),
    () =>
      generateNotes(
        '1.0.0',
        {
          apiKey: secret,
          retryWait: async () => {},
          model: 'model',
          history: 'history',
          diff: 'diff',
          previous: null
        },
        failing
      )
  ]) {
    await assert.rejects(invoke(), error => {
      assert.equal(error.status, 503, error.stack)
      assert.match(error.message, /upstream processing failed/)
      assert.doesNotMatch(
        error.message + JSON.stringify(error),
        /private-test-secret|Bearer |JWT |sessionid=private/
      )
      return true
    })
  }
})

test('subscription catalog and list failures preserve 5xx bodies through error wrapping', async () => {
  const request = async () => new Response('upstream unavailable', { status: 502 })
  const catalog = await globalThis.MegaSubscriptions.refreshCatalog(undefined, request, true)
  assert.equal(catalog.errorDetails.status, 502)
  assert.equal(catalog.errorDetails.responseBody, 'upstream unavailable')
  await assert.rejects(
    globalThis.MegaSubscriptions.download('https://example.org/', 100, request),
    error => {
      assert.equal(globalThis.MegaErrors.details(error).responseBody, 'upstream unavailable')
      return true
    }
  )
})

test('Chrome and Firefox diagnostics apply to every API phase', async () => {
  for (const stage of [':fetchStatus', ':upload', ':publish']) {
    await assert.rejects(
      publishChromeWebStore('v1.0.0', Buffer.from('zip'), {
        env: {
          CWS_PUBLISHER_ID: 'publisher',
          CWS_EXTENSION_ID: 'extension',
          CWS_CLIENT_ID: 'client',
          CWS_CLIENT_SECRET: secret,
          CWS_REFRESH_TOKEN: secret
        },
        retryWait: async () => {},
        request: async (url, options) => {
          if (url.endsWith(stage)) {
            return failing(url, options)
          }
          return new Response(
            JSON.stringify(
              url.endsWith('/token')
                ? { access_token: secret }
                : url.endsWith(':upload')
                  ? { uploadState: 'SUCCEEDED' }
                  : {}
            )
          )
        }
      }),
      error => {
        assert.match(error.message, /upstream processing failed/)
        assert.doesNotMatch(error.message, /private-test-secret/)
        assert.ok(error.message.includes(stage))
        return true
      }
    )
  }
  for (const stage of [
    'accounts/profile/',
    'addons/addon/browser-mega-proxy%40andre487/',
    'versions/1.0.0/'
  ]) {
    await assert.rejects(
      checkFirefoxRelease(
        'v1.0.0',
        {
          version: '1.0.0',
          browser_specific_settings: { gecko: { id: 'browser-mega-proxy@andre487' } }
        },
        {
          env: { WEB_EXT_API_KEY: 'key', WEB_EXT_API_SECRET: secret },
          retryWait: async () => {},
          request: async (url, options) => {
            if (url.endsWith(stage)) {
              return failing(url, options)
            }
            return new Response(
              JSON.stringify(
                url.endsWith('accounts/profile/')
                  ? { id: 1 }
                  : { guid: 'browser-mega-proxy@andre487', authors: [{ id: 1 }] }
              )
            )
          }
        }
      ),
      /upstream processing failed/
    )
  }
})

test('schema and catalog renewal CLI failures print server response details', () => {
  for (const script of ['renew-config-schema', 'renew-list-catalog']) {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `globalThis.fetch = async () => new Response('upstream unavailable', {status: 503}); await import('./scripts/${script}.mjs')`
      ],
      { encoding: 'utf8' }
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /upstream unavailable/)
    assert.match(result.stderr, /503/)
  }
})

test('5xx retries are bounded, preserve request bodies and stop on success, non-retryable 4xx or transport errors', async () => {
  const options = { method: 'POST', body: new URLSearchParams({ value: 'test' }) }
  const waits = []
  let attempts = 0
  const response = await requestWithRetry(
    async (url, actual) => {
      attempts++
      assert.equal(actual, options)
      return new Response(attempts < 3 ? 'temporarily down' : 'accepted', {
        status: attempts < 3 ? 503 : 200
      })
    },
    'https://example.org/upload',
    options,
    { wait: async ms => waits.push(ms) }
  )
  assert.equal(response.status, 200)
  assert.equal(attempts, 3)
  assert.deepEqual(waits, [1000, 2000])
  attempts = 0
  const exhausted = await requestWithRetry(
    async () => {
      attempts++
      return new Response('still down', { status: 500 })
    },
    'https://example.org/upload',
    options,
    { wait: async () => {} }
  )
  assert.equal(attempts, 3)
  assert.equal(await exhausted.text(), 'still down')
  for (const status of [200, 400, 403, 404]) {
    attempts = 0
    await requestWithRetry(
      async () => {
        attempts++
        return new Response('', { status })
      },
      'https://example.org/upload',
      options,
      { wait: () => assert.fail('Must not retry') }
    )
    assert.equal(attempts, 1)
  }
  attempts = 0
  await assert.rejects(
    requestWithRetry(
      async () => {
        attempts++
        throw new TypeError('network failure')
      },
      'https://example.org/upload',
      options,
      { wait: () => assert.fail('Must not retry') }
    ),
    /network failure/
  )
  assert.equal(attempts, 1)
})

test('429 retries use bounded exponential delays and leave the final response readable', async () => {
  const waits = []
  let calls = 0
  const response = await requestWithRetry(
    async () => {
      calls++
      return new Response('Rate limit exceeded', { status: 429 })
    },
    'https://example.org/upload',
    {},
    { maxAttempts: 1, wait: async ms => waits.push(ms) }
  )
  assert.equal(calls, 6)
  assert.deepEqual(waits, [30000, 60000, 120000, 240000, 300000])
  assert.equal(await response.text(), 'Rate limit exceeded')
})

test('429 honors Retry-After seconds and dates without clamping; malformed values use backoff', async () => {
  for (const [header, expected, tolerance = 0] of [
    ['0', 0],
    ['1', 1000],
    ['120', 120000],
    ['600', 600000],
    [new Date(Date.now() + 600000).toUTCString(), 600000, 1000],
    [new Date(Date.now() - 600000).toUTCString(), 0],
    ['invalid', 30000]
  ]) {
    const waits = []
    let calls = 0
    const response = await requestWithRetry(
      async () =>
        ++calls === 1
          ? new Response('', { status: 429, headers: { 'Retry-After': header } })
          : new Response('Accepted'),
      'https://example.org/',
      {},
      { wait: async ms => waits.push(ms) }
    )
    assert.equal(response.status, 200)
    assert.equal(calls, 2)
    assert.equal(waits.length, 1)
    assert.ok(Math.abs(waits[0] - expected) <= tolerance, `${header}: ${waits[0]}`)
  }
})

test('both stores recover from 429 and expose sanitized 400 diagnostics', async () => {
  for (const status of [429, 400]) {
    for (const store of ['chrome', 'firefox']) {
      const waits = []
      const signals = []
      let calls = 0
      const request = async (url, options) => {
        signals.push(options.signal)
        if (++calls === 1) {
          return new Response(JSON.stringify({ error: 'Listing is incomplete', echoed: secret }), {
            status
          })
        }
        const data = url.includes('oauth2')
          ? { access_token: 'access-token' }
          : url.endsWith('accounts/profile/')
            ? { id: 1 }
            : url.includes('addons.mozilla.org')
              ? { guid: 'browser-mega-proxy@andre487', authors: [{ id: 1 }] }
              : {}
        return new Response(JSON.stringify(data))
      }
      const options = { request, retryWait: async ms => waits.push(ms), dryRun: true }
      const invoke = () =>
        store === 'chrome'
          ? publishChromeWebStore('v1.0.0', Buffer.from('zip'), {
              ...options,
              env: {
                CWS_PUBLISHER_ID: 'publisher',
                CWS_EXTENSION_ID: 'extension',
                CWS_CLIENT_ID: 'client',
                CWS_CLIENT_SECRET: secret,
                CWS_REFRESH_TOKEN: secret
              }
            })
          : checkFirefoxRelease(
              'v1.0.0',
              {
                version: '1.0.0',
                browser_specific_settings: { gecko: { id: 'browser-mega-proxy@andre487' } }
              },
              { ...options, env: { WEB_EXT_API_KEY: 'key', WEB_EXT_API_SECRET: secret } }
            )

      if (status === 429) {
        await invoke()
        assert.deepEqual(waits, [30000], store)
        assert.notEqual(signals[0], signals[1], store)
        assert.equal(signals[1].aborted, false)
      } else {
        await assert.rejects(invoke(), error => {
          assert.equal(error.status, 400)
          assert.match(error.message, /Listing is incomplete/)
          assert.ok(!error.message.includes(secret))
          return true
        })
        assert.deepEqual(waits, [])
        assert.equal(calls, 1)
      }
    }
  }
})
