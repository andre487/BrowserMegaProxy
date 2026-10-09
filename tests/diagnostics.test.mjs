import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
const scripts = await Promise.all(
  [
    'errors.js',
    'platform.js',
    'core.js',
    'subscription-catalog.js',
    'subscriptions.js',
    'background.js'
  ].map(file => readFile(`extension/${file}`, 'utf8'))
)

function harness(bypass = [], httpsFails = false, target = 'firefox', mode = 'proxy') {
  const listeners = new Map()
  const event = name => ({
    addListener: callback => {
      if (!listeners.has(name)) {
        listeners.set(name, new Set())
      }
      listeners.get(name).add(callback)
    },
    removeListener: callback => listeners.get(name)?.delete(callback)
  })
  const emit = (name, value) => {
    for (const callback of listeners.get(name) || []) {
      callback(value)
    }
  }
  const urls = []
  const removed = []
  const native = []
  const session = {}
  let url
  const api = {
    runtime: { onMessage: event('message'), id: 'test', getURL: () => 'moz-extension://test/' },
    extension: { isAllowedIncognitoAccess: async () => true },
    proxy: {
      onRequest: event('proxy'),
      settings: { get: async () => ({}), set: async config => native.push(structuredClone(config)) }
    },
    storage: {
      session: {
        get: async () => structuredClone(session),
        set: async data => Object.assign(session, structuredClone(data))
      },
      local: {
        get: async () => ({
          state: {
            profiles: [
              {
                id: 'proxy',
                host: 'proxy.example',
                port: 443,
                username: 'user',
                password: 'secret',
                bypass
              }
            ],
            activeId: mode === 'proxy' ? 'proxy' : null,
            connectionMode: mode,
            browserRouting: { enabled: target === 'chromium', domains: ['selected.example'] }
          }
        }),
        set: async config => native.push(structuredClone(config))
      }
    },
    tabs: {
      onUpdated: {
        addListener: event('updated').addListener,
        removeListener: event('updated').removeListener
      },
      create: async () => ({ id: 7 }),
      remove: async id => {
        removed.push(id)
      },
      update: async (id, changes) => {
        url = changes.url
        urls.push(url)
        queueMicrotask(() => {
          if (
            (httpsFails && url.includes('example.com')) ||
            url.includes('ifconfig.me') ||
            url.includes('country') ||
            url.includes('ifconfig.co')
          ) {
            emit('error', {
              tabId: id,
              type: 'main_frame',
              requestId: String(urls.length),
              url,
              error: 'network failure'
            })
          } else {
            emit('completed', {
              tabId: id,
              type: 'main_frame',
              requestId: String(urls.length),
              url,
              statusCode: 200
            })
            for (const callback of listeners.get('updated') || []) {
              callback(id, { status: 'complete' }, { url })
            }
          }
        })
      }
    },
    scripting: {
      executeScript: async () => [
        { result: url.includes('api.ipify.org') ? 'invalid IP' : '203.0.113.9' }
      ]
    },
    webRequest: {
      onAuthRequired: event('auth'),
      onCompleted: event('completed'),
      onErrorOccurred: event('error')
    }
  }
  const context = vm.createContext({
    browser: api,
    MEGA_TARGET: target,
    crypto,
    URL,
    TextEncoder,
    btoa,
    structuredClone,
    AbortSignal
  })
  scripts.forEach(script => vm.runInContext(script, context))
  // runtime listeners have three arguments, unlike network event callbacks.
  const command = message =>
    new Promise(resolve => [...listeners.get('message')][0](message, { id: 'test' }, resolve))
  return { command, urls, removed, native, api, session }
}

test('connection check falls back on transport and invalid IP responses, treats country as optional and closes its tab', async () => {
  const h = harness()
  const result = await h.command({ command: 'check' })
  assert.equal(result.ok, true)
  assert.equal(result.connectionCheck.exitIp, '203.0.113.9')
  assert.equal(result.connectionCheck.countryCode, '')
  assert.equal(h.urls.length, 7)
  assert.deepEqual(h.removed, [7])
})

test('failed HTTPS check closes its tab, and bypassed diagnostic hosts cannot report direct access as proxy success', async () => {
  const failed = harness([], true)
  assert.equal((await failed.command({ command: 'check' })).error, 'errorCheckNetwork')
  assert.deepEqual(failed.removed, [7])
  const bypassed = harness(['example.com'])
  assert.equal((await bypassed.command({ command: 'check' })).error, 'errorCheckBypass')
  assert.equal(bypassed.urls.length, 0)
  const status = (await bypassed.command({ command: 'get' })).connectionCheck
  assert.equal(status.stage, 'failed')
  assert.equal(status.error, 'errorCheckBypass')
  assert.equal(bypassed.session.connectionCheck.stage, 'failed')
})

test('temporary proxy setup and restoration failures replace a previous successful check', async () => {
  for (const failureAt of [1, 2]) {
    const h = harness([], false, 'chromium')
    assert.equal((await h.command({ command: 'check' })).ok, true)
    let calls = 0
    h.api.proxy.settings.set = async () => {
      if (++calls === failureAt) {
        throw new Error('net::ERR_FAILED')
      }
    }
    assert.equal((await h.command({ command: 'check' })).ok, false)
    assert.equal((await h.command({ command: 'get' })).connectionCheck.stage, 'failed')
    assert.equal(h.session.connectionCheck.stage, 'failed')
  }
})

test('diagnostic temporary PAC includes only check hosts and restores routing on success and failure', async () => {
  for (const fails of [false, true]) {
    const h = harness([], fails, 'chromium')
    const result = await h.command({ command: 'check' })
    assert.equal(result.ok, !fails)
    assert.equal(h.native.length, 2)
    const pac = vm.createContext({})
    vm.runInContext(h.native[0].value.pacScript.data, pac)
    assert.equal(
      pac.FindProxyForURL('https://example.com/', 'example.com'),
      'HTTPS proxy.example:443'
    )
    assert.equal(pac.FindProxyForURL('http://localhost/', 'localhost'), 'DIRECT')
    vm.runInContext(h.native[1].value.pacScript.data, pac)
    assert.equal(pac.FindProxyForURL('https://example.com/', 'example.com'), 'DIRECT')
    assert.equal(
      pac.FindProxyForURL('https://selected.example/', 'selected.example'),
      'HTTPS proxy.example:443'
    )
    assert.deepEqual(h.removed, [7])
  }
})

test('Direct and System checks preserve browser routing and close diagnostic tabs on success and failure', async () => {
  for (const target of ['chromium', 'firefox']) {
    for (const mode of ['direct', 'system']) {
      for (const fails of [false, true]) {
        const h = harness(['example.com'], fails, target, mode)
        const result = await h.command({ command: 'check' })
        assert.equal(result.ok, !fails)
        if (!fails) {
          assert.equal(result.connectionCheck.mode, mode)
          assert.equal(result.connectionCheck.profileId, null)
          assert.equal(result.connectionCheck.exitIp, '203.0.113.9')
        } else {
          assert.equal(result.error, 'errorCheckNetwork')
          assert.equal((await h.command({ command: 'get' })).connectionCheck.mode, mode)
        }
        assert.equal(
          h.native.length,
          0,
          'diagnostics must not overwrite Direct or System proxy settings'
        )
        assert.deepEqual(h.removed, [7])
        assert.equal((await h.command({ command: 'get' })).state.connectionMode, mode)
      }
    }
  }
})
