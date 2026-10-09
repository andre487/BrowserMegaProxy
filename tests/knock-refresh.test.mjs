import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'

const source = (
  await Promise.all(
    [
      'errors.js',
      'platform.js',
      'core.js',
      'subscription-catalog.js',
      'subscriptions.js',
      'background.js'
    ].map(name => readFile(`extension/${name}`, 'utf8'))
  )
).join('\n;\n')

function harness(target = 'chromium', session = {}, opened = new Map(), savedCredentials = true) {
  const events = {}
  const reloaded = []
  const created = []
  const navigations = []
  const event = key => {
    const callbacks = new Set()
    events[key] = (...args) => {
      for (const listener of callbacks) {
        listener(...args)
      }
    }
    return { addListener: fn => callbacks.add(fn), removeListener: fn => callbacks.delete(fn) }
  }
  const profile = {
    id: 'one',
    host: 'proxy.example',
    port: 443,
    username: savedCredentials ? 'user' : '',
    password: savedCredentials ? 'secret' : '',
    knockHost: 'knock.example'
  }
  const api = {
    runtime: {
      id: 'test',
      getURL: () => 'chrome-extension://test/',
      onMessage: event('message'),
      onInstalled: event('installed'),
      onStartup: event('startup')
    },
    extension: { isAllowedIncognitoAccess: async () => true },
    storage: {
      local: {
        get: async () => ({
          state: {
            statisticsEnabled: false,
            profiles: [profile],
            activeId: profile.id,
            browserRouting: { enabled: true, domains: ['**.example.com'] }
          }
        }),
        set: async () => {}
      },
      session: {
        get: async () => structuredClone(session),
        set: async data => Object.assign(session, structuredClone(data))
      }
    },
    proxy: {
      onRequest: event('proxy'),
      settings: { get: async () => ({}), set: async () => {}, clear: async () => {} }
    },
    tabs: {
      query: async () => [...opened.values()],
      get: async id => {
        if (!opened.has(id)) {
          throw new Error('closed')
        }
        return opened.get(id)
      },
      create: async tab => {
        created.push(tab)
        opened.set(99, { id: 99, ...tab })
        return { id: 99 }
      },
      reload: async id => reloaded.push(id),
      update: async (id, change) => {
        navigations.push({ id, ...change })
        return Object.assign(opened.get(id), change)
      },
      remove: async id => opened.delete(id),
      onActivated: event('activated'),
      onUpdated: event('updated'),
      onRemoved: event('removed')
    },
    webRequest: Object.fromEntries(
      ['onCompleted', 'onErrorOccurred', 'onAuthRequired'].map(name => [name, event(name)])
    )
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
  vm.runInContext(source, context)
  const send = message => new Promise(resolve => events.message(message, { id: 'test' }, resolve))
  const flush = () => vm.runInContext('queue', context)
  const complete = statusCode =>
    events.onCompleted({ tabId: 99, type: 'main_frame', url: 'https://knock.example/', statusCode })
  const activate = async id => {
    events.activated({ tabId: id })
    await flush()
  }
  return {
    api,
    events,
    send,
    flush,
    complete,
    activate,
    reloaded,
    opened,
    session,
    created,
    navigations
  }
}

const tabs = () =>
  new Map([
    [1, { id: 1, url: 'https://example.com/' }],
    [2, { id: 2, url: 'https://child.example.com/' }],
    [3, { id: 3, url: 'https://direct.example.net/' }],
    [4, { id: 4, url: 'chrome://settings/' }],
    [5, { id: 5, url: 'https://other.example.com/', discarded: true }]
  ])

test('new knock tabs use unique query strings while pending tabs retain their navigation', async () => {
  const h = harness('chromium', {}, tabs())
  await h.send({ command: 'knock' })
  const first = h.opened.get(99).url
  assert.equal(new URL(first).origin, 'https://knock.example')
  assert.ok(new URL(first).searchParams.has('r'))
  await h.send({ command: 'knock' })
  assert.equal(h.navigations.length, 1, 'Reuse the pending tab without navigating again')
  h.complete(200)
  h.events.updated(99, { status: 'complete' }, { url: first })
  await h.flush()
  assert.equal(h.opened.has(99), false)
  await h.send({ command: 'knock' })
  assert.notEqual(h.opened.get(99).url, first)
})

test('Chromium retries a knock interrupted by proxy settings once, then closes on success or leaves a repeated failure open', async () => {
  for (const [tabURL, repeatedFailure] of [
    ['https://knock.example/', false],
    ['chrome-error://chromewebdata/', false],
    ['about:blank', false],
    ['chrome-error://chromewebdata/', true]
  ]) {
    const h = harness('chromium', {}, tabs())
    await h.send({ command: 'knock' })
    h.opened.get(99).url = tabURL
    const error = {
      tabId: 99,
      type: 'main_frame',
      url: h.navigations[0].url,
      error: 'net::ERR_NETWORK_CHANGED'
    }
    h.events.onErrorOccurred(error)
    await h.flush()
    assert.equal(h.navigations.length, tabURL === 'about:blank' ? 2 : 1)
    if (tabURL === 'about:blank') {
      assert.deepEqual(h.navigations[0], h.navigations[1])
      assert.deepEqual(h.reloaded, [])
    } else {
      assert.deepEqual(h.reloaded, [99])
    }
    assert.equal(h.created.length, 1)
    assert.equal(h.session.knockTabs[0].retried, true)
    assert.ok(h.session.knockRefresh.pending)
    if (repeatedFailure) {
      h.events.onErrorOccurred(error)
      await h.flush()
      assert.equal(h.session.knockTabs.length, 0)
      assert.equal(h.opened.has(99), true)
    } else {
      h.opened.get(99).url = error.url
      h.complete(200)
      h.events.updated(99, { status: 'complete' }, { url: error.url })
      await h.flush()
      assert.equal(h.opened.has(99), false)
    }
    assert.equal(h.navigations.length, tabURL === 'about:blank' ? 2 : 1)
    assert.equal(h.reloaded.length, tabURL === 'about:blank' ? 0 : 1)
  }
})

test('Chromium never retries an interrupted knock after the user navigates elsewhere', async () => {
  const h = harness('chromium', {}, tabs())
  await h.send({ command: 'knock' })
  h.opened.get(99).url = 'https://other.example/'
  h.events.onErrorOccurred({
    tabId: 99,
    type: 'main_frame',
    url: 'https://knock.example/',
    error: 'net::ERR_NETWORK_CHANGED'
  })
  await h.flush()
  assert.equal(h.navigations.length, 1)
  assert.equal(h.opened.get(99).url, 'https://other.example/')
  assert.equal(h.session.knockTabs.length, 0)
})

test('Chromium startup marks only existing routed tabs after knock succeeds and reloads each once on activation', async () => {
  const h = harness('chromium', {}, tabs())
  await h.send({ command: 'get' })
  h.events.startup()
  await h.flush()
  await h.activate(1)
  assert.deepEqual(h.reloaded, [])
  h.opened.set(6, { id: 6, url: 'https://new.example.com/' })
  h.events.onCompleted({
    tabId: 99,
    type: 'image',
    url: 'https://knock.example/icon',
    statusCode: 200
  })
  await h.flush()
  assert.equal(h.session.knockRefresh.tabs.length, 0)
  h.complete(200)
  await h.flush()
  assert.deepEqual(
    h.session.knockRefresh.tabs.map(tab => tab.id),
    [1, 2]
  )
  assert.deepEqual(h.reloaded, [])
  for (const id of [1, 1, 2, 3, 4, 5, 6, 99]) {
    await h.activate(id)
  }
  assert.deepEqual(h.reloaded, [1, 2])
  assert.deepEqual(h.session.knockRefresh.tabs, [])
})

test('failed knock, profile disconnect, changed URLs and closed tabs never cause stale reloads', async () => {
  for (const failure of ['http', 'network', 'disconnect']) {
    const h = harness('chromium', {}, tabs())
    await h.send({ command: 'knock' })
    if (failure === 'network') {
      h.events.onErrorOccurred({
        tabId: 99,
        type: 'main_frame',
        url: 'https://knock.example/',
        error: 'net::ERR_ABORTED'
      })
    } else {
      if (failure === 'disconnect') {
        await h.send({ command: 'activate', id: null })
      }
      h.complete(failure === 'http' ? 407 : 200)
    }
    await h.flush()
    await h.activate(1)
    assert.deepEqual(h.reloaded, [])
  }
  const h = harness('chromium', {}, tabs())
  await h.send({ command: 'knock' })
  h.complete(200)
  await h.flush()
  h.opened.get(1).url = 'https://new.example.com/'
  h.events.updated(1, { url: 'https://new.example.com/' })
  h.opened.delete(2)
  h.events.removed(2)
  await h.flush()
  await h.activate(1)
  await h.activate(2)
  assert.deepEqual(h.reloaded, [])
})

test('reload markers survive Chromium service worker recreation and Firefox never registers this behavior', async () => {
  const session = {}
  const opened = tabs()
  const first = harness('chromium', session, opened)
  await first.send({ command: 'knock' })
  first.complete(200)
  await first.flush()
  const resumed = harness('chromium', session, opened)
  await resumed.flush()
  await resumed.activate(1)
  await resumed.activate(1)
  assert.deepEqual(resumed.reloaded, [1])
  const firefox = harness('firefox', {}, tabs())
  await firefox.flush()
  assert.equal(typeof firefox.events.activated, 'function')
  firefox.events.activated({ tabId: 1 })
  await firefox.flush()
  assert.deepEqual(firefox.reloaded, [])
  assert.equal(firefox.session.knockRefresh, undefined)
})

test('IPv6 knock success is recognized without marking its own host for refresh', async () => {
  const h = harness('chromium', {}, tabs())
  await h.send({ command: 'routing', routing: { enabled: false } })
  await h.send({ command: 'bypassLocalNetworks', enabled: false })
  h.opened.set(6, { id: 6, url: 'https://[::1]/existing' })
  const p = (await h.send({ command: 'get' })).state.profiles[0]
  assert.equal((await h.send({ command: 'save', profile: { ...p, knockHost: '::1' } })).ok, true)
  assert.equal(
    h.session.knockRefresh.pending.tabs.some(tab => tab.id === 6),
    false
  )
  h.events.onCompleted({ tabId: 99, type: 'main_frame', url: 'https://[::1]/', statusCode: 200 })
  await h.flush()
  await h.activate(1)
  assert.deepEqual(h.reloaded, [1])
})

for (const target of ['chromium', 'firefox']) {
  test(`${target} closes an active native-auth knock tab only after a successful response and full load`, async () => {
    for (const loadFirst of [false, true]) {
      const h = harness(target, {}, tabs(), false)
      await h.send({ command: 'knock' })
      assert.equal(h.created[0].active, true)
      const auth = await new Promise(resolve =>
        h.events.onAuthRequired(
          { isProxy: true, requestId: 'native', challenger: { host: 'proxy.example', port: 443 } },
          resolve
        )
      )
      assert.deepEqual(JSON.parse(JSON.stringify(auth)), {})
      const loaded = () =>
        h.events.updated(99, { status: 'complete' }, { url: 'https://knock.example/' })
      if (loadFirst) {
        loaded()
      } else {
        h.complete(200)
      }
      await h.flush()
      assert.equal(h.opened.has(99), true, 'both a successful response and full load are required')
      if (loadFirst) {
        h.complete(200)
      } else {
        loaded()
      }
      await h.flush()
      assert.equal(h.opened.has(99), false)
      assert.equal(h.opened.has(1), true)
    }
  })

  test(`${target} closes only successful fully loaded knock tabs and leaves failures open`, async () => {
    for (const outcome of ['success', 'http', 'network']) {
      const h = harness(target, {}, tabs(), target !== 'firefox')
      assert.equal((await h.send({ command: 'knock' })).ok, true)
      if (outcome === 'network') {
        h.events.onErrorOccurred({ tabId: 99, type: 'main_frame', url: 'https://knock.example/' })
      } else {
        h.complete(outcome === 'http' ? 407 : 200)
      }
      await h.flush()
      assert.equal(h.opened.has(99), true, 'a response alone must not close the tab')
      h.events.updated(99, { status: 'complete' }, { url: 'https://knock.example/' })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(h.opened.has(99), outcome !== 'success', outcome)
      assert.equal(h.opened.has(1), true, 'unrelated tabs remain open')
    }
  })
}

for (const target of ['chromium', 'firefox']) {
  test(`${target} reuses pending knock tabs across startup events and worker recreation`, async () => {
    const session = {}
    const opened = tabs()
    const first = harness(target, session, opened, target !== 'firefox')
    first.events.startup()
    first.events.installed()
    await first.flush()
    await first.send({ command: 'knock' })
    assert.equal(first.created.length, 1)
    assert.equal(first.created[0].active, target === 'firefox')
    first.complete(200)
    await first.flush()
    assert.equal(opened.has(99), true)
    const resumed = harness(target, session, opened, target !== 'firefox')
    await resumed.flush()
    await resumed.send({ command: 'knock' })
    assert.equal(resumed.created.length, 0)
    resumed.events.updated(99, { status: 'complete' }, { url: 'https://knock.example/' })
    await resumed.flush()
    assert.equal(opened.has(99), false)
    resumed.events.startup()
    await resumed.flush()
    assert.equal(resumed.created.length, 0)
  })
}
