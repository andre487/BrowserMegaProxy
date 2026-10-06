import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
const core =
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
      getURL: () => 'chrome-extension://test/',
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
    URL,
    TextEncoder,
    btoa,
    structuredClone
  })
  vm.runInContext(core, context)
  vm.runInContext(background, context)
  const send = message => new Promise(resolve => events.message(message, { id: 'test' }, resolve))
  const flush = () => vm.runInContext('queue', context)

  return { events, tabs, proxy, send, flush }
}

test('startup and activation knock matrix uses saved credentials and browser; native prompt is left to the browser', async () => {
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
      const expected = target === 'chromium' || !credentials.password
      assert.equal(h.tabs.length, expected ? 1 : 0, `${target} startup`)
      await h.send({ command: 'activate', id: null })
      const response = await h.send({ command: 'activate', id: 'one' })
      assert.equal(response.ok, true)
      assert.equal(h.tabs.length, expected ? 1 : 0, `${target} activation reuses pending knock`)
      const auth = await new Promise(resolve =>
        h.events.onAuthRequired(
          { isProxy: true, requestId: 'auth', challenger: { host: 'proxy.example', port: 443 } },
          resolve
        )
      )
      assert.equal(Boolean(auth.authCredentials), Boolean(credentials.password))
      if (!expected) {
        assert.equal((await h.send({ command: 'knock' })).error, 'errorKnockDisabled')
      }
    }
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

test('cloning, ordering and failover retain proxy routing after all candidates fail', async () => {
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
  await h.send({ command: 'failover', mode: 'ALL', ids: [] })
  await h.send({ command: 'connectionMode', mode: 'failover' })
  for (let i = 0; i < 3; i++) {
    h.events.onErrorOccurred({
      url: 'https://target.example/',
      requestId: `first-${i}`,
      tabId: 1,
      type: 'main_frame',
      error: 'NS_ERROR_PROXY_CONNECTION_REFUSED'
    })
    await h.flush()
  }
  await new Promise(resolve => setImmediate(resolve))
  await h.flush()
  assert.equal((await h.send({ command: 'get' })).state.activeId, id)
  for (let i = 0; i < 3; i++) {
    h.events.onErrorOccurred({
      url: 'https://target.example/',
      requestId: `second-${i}`,
      tabId: 1,
      type: 'main_frame',
      error: 'NS_ERROR_PROXY_CONNECTION_REFUSED'
    })
    await h.flush()
  }
  await new Promise(resolve => setImmediate(resolve))
  await h.flush()
  const result = await h.send({ command: 'get' })
  assert.equal(result.state.activeId, id)
  assert.equal(result.warning, 'errorFailoverExhausted')
  assert.equal(h.proxy.includes(null), false)
})
