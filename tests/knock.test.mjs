import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
const core =
  (await readFile('extension/errors.js', 'utf8')) +
  (await readFile('extension/platform.js', 'utf8')) +
  ';\n' +
  (await readFile('extension/core.js', 'utf8')) +
  ';\n' +
  (await readFile('extension/subscription-catalog.js', 'utf8')) +
  ';\n' +
  (await readFile('extension/subscriptions.js', 'utf8'))
const background = await readFile('extension/background.js', 'utf8')

function harness(target, credentials) {
  const events = {}
  const tabs = []
  const proxy = []
  const diagnostics = []
  const listener = name => ({
    addListener: fn => {
      events[name] = fn
    }
  })
  const p = {
    id: 'one',
    name: 'One',
    host: 'proxy.example',
    port: 443,
    knockHost: 'knock.example',
    ...credentials
  }
  const api = {
    runtime: {
      id: 'test',
      getURL: (path = '') => `chrome-extension://test/${path}`,
      onMessage: listener('message'),
      onStartup: listener('startup'),
      onInstalled: listener('installed')
    },
    extension: { isAllowedIncognitoAccess: async () => true },
    storage: {
      local: {
        get: async () => ({ state: { statisticsEnabled: false, profiles: [p], activeId: 'one' } }),
        set: async () => {}
      }
    },
    tabs: {
      get: async id => tabs.find(tab => tab.id === id),
      update: async (id, change) =>
        Object.assign(
          tabs.find(tab => tab.id === id),
          change
        ),
      query: async () => [],
      create: async tab => {
        const opened = { id: tabs.length + 1, ...tab }
        tabs.push(opened)
        return opened
      }
    },
    proxy: {
      onRequest: listener('proxyRequest'),
      settings: {
        get: async () => ({}),
        set: async value => {
          proxy.push(value)
        },
        clear: async () => {
          proxy.push(null)
        }
      }
    },
    webRequest: Object.fromEntries(
      ['onAuthRequired', 'onCompleted', 'onErrorOccurred'].map(name => [name, listener(name)])
    )
  }
  const context = vm.createContext({
    browser: api,
    MEGA_TARGET: target,
    crypto,
    AbortController,
    AbortSignal,
    URL,
    TextEncoder,
    btoa,
    structuredClone,
    indexedDB: {},
    MegaDiagnosticLog: class {
      write(event) {
        diagnostics.push(event)
      }
    }
  })
  vm.runInContext(core, context)
  vm.runInContext(background, context)
  const send = message =>
    new Promise(resolve =>
      events.message(
        message,
        {
          id: 'test',
          url: message.command.startsWith('auth')
            ? api.runtime.getURL('auth.html') + '?id=' + message.token
            : undefined
        },
        resolve
      )
    )
  const flush = () => vm.runInContext('queue', context)

  return { events, tabs, proxy, diagnostics, send, flush }
}

test('proxy authentication without knock follows the challenger even when current routing excludes the request', async () => {
  const h = harness('chromium', { username: 'user', password: 'secret', knockHost: '' })
  await h.send({
    command: 'routing',
    routing: { enabled: true, mode: 'domains', domains: ['selected.example'] }
  })
  const details = {
    requestId: 'old-tab',
    tabId: 42,
    type: 'xmlhttprequest',
    url: 'https://excluded.example/resource',
    isProxy: true,
    challenger: { host: 'proxy.example', port: 443 }
  }
  const auth = extra =>
    new Promise(resolve => h.events.onAuthRequired({ ...details, ...extra }, resolve))
  assert.deepEqual(JSON.parse(JSON.stringify(await auth())), {
    authCredentials: { username: 'user', password: 'secret' }
  })
  const rejected = auth()
  await new Promise(setImmediate)
  const token = new URL(h.tabs.find(tab => tab.url.includes('auth.html')).url).searchParams.get(
    'id'
  )
  await h.send({ command: 'authCancel', token })
  assert.equal((await rejected).cancel, true)
  h.events.onCompleted({ ...details, type: 'image' })
  assert.ok((await auth()).authCredentials)
  assert.equal(Object.keys(await auth({ isProxy: false })).length, 0)
  assert.equal(
    Object.keys(await auth({ challenger: { host: 'other.example', port: 443 } })).length,
    0
  )
  assert.equal(
    Object.keys(await auth({ challenger: { host: 'proxy.example', port: 80 } })).length,
    0
  )
  assert.ok(h.diagnostics.includes('proxy_auth_required'))
  assert.ok(h.diagnostics.includes('proxy_auth_supplied'))
  assert.ok(h.diagnostics.includes('proxy_auth_cancelled'))
  assert.ok(h.diagnostics.includes('proxy_auth_skipped'))
  assert.equal(h.tabs.length, 1)
  assert.equal(h.tabs[0].active, true)
})

test('startup and activation knock matrix supplies saved credentials and leaves empty credentials to the browser', async () => {
  for (const target of ['chromium', 'firefox']) {
    for (const credentials of [
      {},
      { username: 'user' },
      { username: 'user', password: 'secret' }
    ]) {
      const h = harness(target, credentials)
      await h.send({ command: 'get' })
      h.events.startup()
      await h.flush()
      assert.equal(h.tabs.length, 1, `${target} startup`)
      assert.equal(h.tabs[0].active, !credentials.password)
      h.tabs[0].active = false
      await h.send({ command: 'activate', id: null })
      const response = await h.send({ command: 'activate', id: 'one' })
      assert.equal(response.ok, true)
      assert.equal(h.tabs.length, 1, `${target} activation reuses pending knock`)
      assert.equal(h.tabs[0].active, !credentials.password)
      const pendingAuth = new Promise(resolve =>
        h.events.onAuthRequired(
          { isProxy: true, requestId: 'auth', challenger: { host: 'proxy.example', port: 443 } },
          resolve
        )
      )
      if (!credentials.password) {
        assert.deepEqual(JSON.parse(JSON.stringify(await pendingAuth)), {})
        const repeated = await new Promise(resolve =>
          h.events.onAuthRequired(
            { isProxy: true, requestId: 'auth', challenger: { host: 'proxy.example', port: 443 } },
            resolve
          )
        )
        assert.deepEqual(JSON.parse(JSON.stringify(repeated)), {})
        assert.equal(
          h.tabs.some(tab => tab.url.includes('auth.html')),
          false
        )
        assert.ok(h.diagnostics.includes('proxy_auth_skipped'))
      }
      const auth = await pendingAuth
      assert.equal(Boolean(auth.authCredentials), Boolean(credentials.password))
    }
  }
})

test('automatic Firefox knock with saved credentials uses the proxy under selective routing', async () => {
  const h = harness('firefox', { username: 'user', password: 'secret' })
  await h.send({ command: 'routing', routing: { enabled: true, domains: ['included.example'] } })
  h.events.startup()
  await h.flush()
  assert.equal(h.tabs.length, 1, 'saved credentials still require knock for masked auth failures')
  assert.equal(h.tabs[0].active, false)
  const request = { tabId: h.tabs[0].id, type: 'main_frame', url: h.tabs[0].url }
  const route = await h.events.proxyRequest(request)
  assert.equal(route[0].host, 'proxy.example')
  assert.equal(route[0].proxyAuthorizationHeader, `Basic ${btoa('user:secret')}`)
  assert.equal((await h.events.proxyRequest({ ...request, tabId: 999 }))[0].host, 'proxy.example')
  assert.equal(
    (await h.events.proxyRequest({ ...request, url: 'https://other.example/' })).type,
    'direct'
  )
  assert.equal((await h.send({ command: 'knock' })).ok, true)
  assert.equal(h.tabs.length, 1, 'repeated manual knock reuses the pending tab')
})

test('manual knock still rejects local-network bypass and SOCKS5', async () => {
  for (const target of ['firefox', 'chromium']) {
    const bypassed = harness(target, {
      username: 'user',
      password: 'secret',
      knockHost: 'localhost'
    })
    assert.equal((await bypassed.send({ command: 'knock' })).error, 'errorKnockBypass')
    assert.equal(bypassed.tabs.length, 0)
    const socks = harness(target, { type: 'socks5' })
    assert.equal((await socks.send({ command: 'knock' })).error, 'errorKnockDisabled')
    assert.equal(socks.tabs.length, 0)
  }
})

test('startup and activation without a knock host work in both browsers without warnings', async () => {
  for (const target of ['chromium', 'firefox']) {
    for (const credentials of [{}, { username: 'user', password: 'secret' }]) {
      const h = harness(target, { ...credentials, knockHost: '' })
      await h.send({ command: 'get' })
      h.events.startup()
      await h.flush()
      assert.equal(h.tabs.length, 0)
      assert.equal((await h.send({ command: 'get' })).warning, undefined)
      await h.send({ command: 'activate', id: null })
      const activated = await h.send({ command: 'activate', id: 'one' })
      assert.equal(activated.ok, true)
      assert.equal(activated.state.activeId, 'one')
      assert.equal(activated.state.connectionMode, 'proxy')
      assert.equal((await h.send({ command: 'get' })).warning, undefined)
      assert.equal(h.tabs.length, 0)
    }
  }
})

test('missing knock is optional and configured bypassed knock still rejects activation', async () => {
  const h = harness('chromium', {})
  await h.send({
    command: 'save',
    profile: { id: 'one', host: 'proxy.example', port: 443, knockHost: '' }
  })
  await h.send({ command: 'activate', id: null })
  const activated = await h.send({ command: 'activate', id: 'one' })
  assert.equal(activated.ok, true)
  assert.equal(activated.state.activeId, 'one')
  assert.equal(activated.state.connectionMode, 'proxy')
  assert.equal((await h.send({ command: 'get' })).warning, undefined)
  await h.send({ command: 'activate', id: null })
  await h.send({
    command: 'save',
    profile: { id: 'one', host: 'proxy.example', port: 443, knockHost: 'localhost' }
  })
  assert.equal((await h.send({ command: 'activate', id: 'one' })).error, 'errorKnockBypass')
  assert.equal(h.tabs.length, 0)
})

test('cloning and ordering retain the selected profile', async () => {
  const h = harness('firefox', { username: 'user', password: 'secret' })
  const clone = await h.send({ command: 'clone', id: 'one', name: 'Copy' })
  const id = clone.state.profiles[1].id
  assert.notEqual(id, 'one')
  const moved = await h.send({ command: 'move', id, direction: -1 })
  assert.equal(moved.state.profiles[0].id, id)
  const reordered = await h.send({ command: 'move', id, position: 1 })
  assert.equal(reordered.state.profiles[1].id, id)
  const invalid = await h.send({ command: 'move', id, position: 1.5 })
  assert.equal(invalid.ok, false)
  assert.equal((await h.send({ command: 'get' })).state.profiles[1].id, id)
  assert.equal((await h.send({ command: 'get' })).state.activeId, 'one')
})

test('Firefox masked proxy knock exposes rejected saved credentials to the authentication dialog', async () => {
  const h = harness('firefox', { username: 'user', password: 'wrong-password' })
  h.events.startup()
  await h.flush()
  const tab = h.tabs[0]
  assert.equal(new URL(tab.url).hostname, 'knock.example')
  assert.equal(tab.active, false)
  const details = {
    requestId: 'masked-knock',
    tabId: tab.id,
    url: tab.url,
    type: 'main_frame',
    isProxy: true,
    challenger: { host: 'proxy.example', port: 443 }
  }
  const challenge = () => new Promise(resolve => h.events.onAuthRequired(details, resolve))
  assert.equal((await challenge()).authCredentials.password, 'wrong-password')
  const rejected = challenge()
  await new Promise(setImmediate)
  const dialog = h.tabs.find(tab => tab.url.includes('auth.html'))
  assert.ok(dialog, 'knock challenge must open the existing credential correction dialog')
  const token = new URL(dialog.url).searchParams.get('id')
  await h.send({ command: 'authCancel', token })
  assert.equal((await rejected).cancel, true)
})
