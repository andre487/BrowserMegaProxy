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

function harness(target = 'firefox', shared = {}, fetch = globalThis.fetch, initial = {}) {
  const events = {}
  const menus = new Map()
  const calls = []
  let stored
  const setting = name => ({
    get: async () => ({ value: 'default', levelOfControl: 'controllable_by_this_extension' }),
    set: async value => calls.push([name, value.value]),
    clear: async () => calls.push([name, 'clear'])
  })
  const listener = name => {
    const callbacks = new Set()
    events[name] = (...args) => {
      let result
      for (const fn of callbacks) {
        result = fn(...args)
      }
      return result
    }
    return {
      addListener: fn => callbacks.add(fn),
      removeListener: fn => callbacks.delete(fn),
      callbacks
    }
  }
  const api = {
    alarms: initial.alarms,
    notifications: initial.notifications,
    runtime: {
      id: 'test',
      getManifest: () => ({ version: '1.2.3' }),
      getURL: path => `moz-extension://test/${path}`,
      onMessage: listener('message'),
      onStartup: listener('startup'),
      openOptionsPage: async () => calls.push(['options'])
    },
    extension: { isAllowedIncognitoAccess: async () => true },
    permissions: { contains: async () => true },
    privacy: {
      network: {
        webRTCIPHandlingPolicy: setting('policy'),
        peerConnectionEnabled: target === 'firefox' ? setting('peer') : undefined
      }
    },
    i18n: { getMessage: key => key },
    contextMenus: {
      removeAll: async () => menus.clear(),
      create: item => menus.set(item.id, item),
      onClicked: listener('menu')
    },
    windows: {
      create: async options => {
        calls.push(['authWindow', options])
        return { id: 8, tabs: [{ id: 9 }] }
      },
      update: async (id, options) => calls.push(['focusWindow', id, options]),
      onRemoved: listener('windowRemoved')
    },
    tabs: {
      update: async (id, options) => calls.push(['updateTab', id, options]),
      query: async () => [{ id: 1, url: 'https://sub.example.com/' }],
      get: async () => ({ url: 'https://sub.example.com/' }),
      reload: async () => {},
      create: async () => ({ id: 2 }),
      onRemoved: listener('removed'),
      onUpdated: listener('updated')
    },
    proxy: {
      onRequest: listener('proxy'),
      settings: {
        get: async () => ({}),
        set: async config => calls.push(['proxy', structuredClone(config)]),
        clear: async () => calls.push(['proxy-clear'])
      }
    },
    webRequest: Object.fromEntries(
      ['onAuthRequired', 'onCompleted', 'onErrorOccurred'].map(name => [name, listener(name)])
    ),
    storage: {
      session: {
        get: async () => structuredClone(initial.session || {}),
        set: async data =>
          Object.assign(initial.session || (initial.session = {}), structuredClone(data))
      },
      local: {
        get: async () => ({ state: initial.state }),
        set: async value => {
          calls.push(['storage'])
          stored = { ...stored, ...value }
        }
      },
      sync: {
        get: async () => structuredClone(shared),
        set: async value => Object.assign(shared, structuredClone(value)),
        remove: async keys => {
          keys.forEach(key => delete shared[key])
        }
      },
      onChanged: listener('changed')
    }
  }
  const context = vm.createContext({
    browser: api,
    MEGA_TARGET: target,
    crypto,
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    btoa,
    structuredClone,
    fetch,
    setTimeout: callback => setTimeout(callback, 0),
    AbortSignal
  })
  vm.runInContext(source, context)
  const send = message => new Promise(resolve => events.message(message, { id: 'test' }, resolve))
  const flush = () => vm.runInContext('queue', context)
  return { send, events, menus, calls, api, context, flush, stored: () => stored, shared }
}

async function profiles(h) {
  for (const [id, host] of [
    ['one', 'proxy.example'],
    ['two', 'other.example']
  ]) {
    assert.equal(
      (
        await h.send({
          command: 'save',
          profile: {
            id,
            name: id,
            host,
            port: 443,
            username: id,
            password: `secret-${id}`,
            knockHost: 'knock.example'
          }
        })
      ).ok,
      true
    )
  }
  await h.send({ command: 'activate', id: 'one' })
}

test('Chromium restores an interrupted temporary PAC from saved state when its worker restarts', async () => {
  for (const connectionMode of ['proxy', 'direct', 'system']) {
    for (const temporary of [
      { downloadRouting: { hosts: ['api.github.com'], throughProxy: false } },
      { routingExtraDomains: ['example.com'] }
    ]) {
      const initial = {
        session: {},
        state: {
          profiles: [{ id: 'one', host: 'proxy.example', port: 443 }],
          activeId: 'one',
          connectionMode
        }
      }
      const original = harness('chromium', {}, undefined, initial)
      await original.flush()
      const set = original.api.proxy.settings.set
      original.api.proxy.settings.set = async config => {
        assert.equal(initial.session.transientProxyLease, true, 'Lease must precede native changes')
        await set(config)
      }
      await vm.runInContext(
        `platform.applyTransient({ ...state, ...${JSON.stringify(temporary)} })`,
        original.context
      )
      assert.equal(initial.session.transientProxyLease, true)
      const restarted = harness('chromium', {}, undefined, initial)
      await restarted.flush()
      const calls = restarted.calls.filter(([name]) => ['proxy', 'proxy-clear'].includes(name))
      assert.equal(calls.length, 1)
      if (connectionMode === 'system') {
        assert.equal(calls[0][0], 'proxy-clear')
      } else {
        assert.equal(
          calls[0][1].value.mode,
          connectionMode === 'direct' ? 'direct' : 'fixed_servers'
        )
      }
      assert.equal(initial.session.transientProxyLease, false)
      const clean = harness('chromium', {}, undefined, initial)
      await clean.flush()
      assert.equal(
        clean.calls.some(([name]) => ['proxy', 'proxy-clear'].includes(name)),
        false
      )
    }
  }
})

test('failed temporary proxy restoration keeps the lease until a later worker can restore routing', async () => {
  const initial = {
    session: {},
    state: { profiles: [{ id: 'one', host: 'proxy.example', port: 443 }], activeId: 'one' }
  }
  const h = harness('chromium', {}, undefined, initial)
  await h.flush()
  await vm.runInContext(
    'platform.applyTransient({ ...state, routingExtraDomains: ["example.com"] })',
    h.context
  )
  h.api.proxy.settings.set = async () => {
    throw new Error('native settings unavailable')
  }
  await assert.rejects(vm.runInContext('platform.applyTransient(state)', h.context), /unavailable/)
  assert.equal(initial.session.transientProxyLease, true)
  const restarted = harness('chromium', {}, undefined, initial)
  await restarted.flush()
  assert.equal(initial.session.transientProxyLease, false)
  assert.equal(restarted.calls.find(([name]) => name === 'proxy')[1].value.mode, 'fixed_servers')
})

test('empty synced profiles preserve local connection mode and statistics preference', async () => {
  for (const target of ['chromium', 'firefox']) {
    for (const connectionMode of ['direct', 'system']) {
      const shared = {}
      const receiver = harness(target, shared, undefined, {
        state: {
          profiles: [{ id: 'one', host: 'proxy.example', port: 443 }],
          connectionMode,
          statisticsEnabled: false
        }
      })
      await receiver.flush()
      const sender = harness(target, shared)
      await sender.flush()
      await sender.send({ command: 'sync', enabled: true, includePasswords: true })
      await sender.send({ command: 'delete', id: 'one' })
      receiver.calls.length = 0
      receiver.events.changed({ megaConfig: {} }, 'sync')
      await receiver.flush()
      await receiver.flush()
      const result = await receiver.send({ command: 'get' })
      assert.equal(result.syncError, undefined)
      assert.equal(result.state.profiles.length, 0)
      assert.equal(result.state.activeId, null)
      assert.equal(result.state.connectionMode, connectionMode)
      assert.equal(result.state.statisticsEnabled, false)
      assert.equal(
        receiver.calls.some(([name]) => name === 'proxy-clear'),
        connectionMode === 'system'
      )
    }
  }
})

test('receiving synced lists refreshes active automatic routing immediately and leaves inactive modes offline', async () => {
  for (const target of ['chromium', 'firefox']) {
    for (const connectionMode of ['proxy', 'direct', 'system']) {
      const shared = {}
      const profile = { id: 'one', host: 'proxy.example', port: 443 }
      const sender = harness(target, shared, undefined, { state: { profiles: [profile] } })
      await sender.flush()
      const requests = []
      const receiver = harness(
        target,
        shared,
        async url => {
          requests.push(url)
          return new Response('youtube.com\ncdn.youtube.com\n')
        },
        { state: { profiles: [profile], activeId: 'one', connectionMode } }
      )
      await receiver.flush()
      await receiver.flush()
      assert.equal(requests.length, 0)
      await sender.send({
        command: 'routing',
        routing: {
          enabled: true,
          strategy: 'lists',
          mode: 'domains',
          subscriptions: { domainSources: ['youtube'], autoUpdate: true }
        }
      })
      receiver.events.changed({ megaConfig: {} }, 'sync')
      await receiver.flush()
      await receiver.flush()
      const received = await receiver.send({ command: 'get' })
      assert.equal(received.syncError, undefined)
      assert.equal(received.state.connectionMode, connectionMode)
      if (connectionMode === 'proxy') {
        assert.ok(requests.some(url => url.includes('youtube')))
        assert.equal(
          vm.runInContext('M.routed("https://youtube.com/", state)', receiver.context),
          true
        )
        assert.deepEqual(Array.from(received.state.subscriptionCache.domains), ['**.youtube.com'])
      } else {
        assert.equal(requests.length, 0)
      }
    }
  }
})

test('browser proxy ownership and private access guards preserve state and native Direct/System behavior', async () => {
  for (const target of ['chromium', 'firefox']) {
    const h = harness(target)
    await profiles(h)
    h.calls.length = 0
    h.api.proxy.settings.get = async () => ({ levelOfControl: 'controlled_by_other_extensions' })
    assert.equal(
      (await h.send({ command: 'connectionMode', mode: 'direct' })).error,
      'errorProxyControl'
    )
    assert.equal((await h.send({ command: 'get' })).state.connectionMode, 'proxy')
    assert.equal(
      h.calls.some(([name]) => name === 'proxy' || name === 'proxy-clear'),
      false
    )
    h.api.proxy.settings.get = async () => ({ levelOfControl: 'controllable_by_this_extension' })
    h.api.extension.isAllowedIncognitoAccess = async () => false
    assert.equal(
      (await h.send({ command: 'connectionMode', mode: 'direct' })).ok,
      target === 'chromium'
    )
    if (target === 'firefox') {
      assert.equal((await h.send({ command: 'get' })).state.connectionMode, 'proxy')
    }
    h.api.extension.isAllowedIncognitoAccess = async () => true
    assert.equal((await h.send({ command: 'connectionMode', mode: 'direct' })).ok, true)
    const native = h.calls.filter(([name]) => name === 'proxy').at(-1)[1]
    assert.deepEqual(
      native,
      target === 'chromium'
        ? { value: { mode: 'direct' }, scope: 'regular' }
        : { value: { proxyType: 'none' } }
    )
    assert.equal((await h.send({ command: 'connectionMode', mode: 'system' })).ok, true)
    assert.equal(
      h.calls.some(([name]) => name === 'proxy-clear'),
      true
    )
    assert.equal(h.api.proxy.onRequest.callbacks.size, target === 'firefox' ? 1 : 0)
    if (target === 'firefox') {
      assert.equal(await h.events.proxy({ url: 'https://public.example/', tabId: -1 }), undefined)
    }
  }
})

test('Firefox Android routes without calling unsupported proxy.settings', async () => {
  const h = harness('firefox')
  h.api.runtime.getPlatformInfo = async () => ({ os: 'android' })
  for (const method of ['get', 'set', 'clear']) {
    h.api.proxy.settings[method] = async () => {
      throw new Error('proxy.settings is not supported on android.')
    }
  }

  await profiles(h)
  assert.equal((await h.send({ command: 'activate', id: 'two' })).ok, true)
  assert.equal(
    (await h.events.proxy({ url: 'https://public.example/', tabId: -1 }))[0].host,
    'other.example'
  )
  assert.equal((await h.send({ command: 'connectionMode', mode: 'direct' })).ok, true)
  assert.equal((await h.events.proxy({ url: 'https://public.example/', tabId: -1 })).type, 'direct')
  assert.equal((await h.send({ command: 'connectionMode', mode: 'system' })).ok, true)
  assert.equal(await h.events.proxy({ url: 'https://public.example/', tabId: -1 }), undefined)
})

test('cross-browser sync downgrades tab routing and unsupported privacy without losing profiles', async () => {
  const shared = {}
  const firefox = harness('firefox', shared)
  await profiles(firefox)
  await firefox.send({
    command: 'routing',
    routing: {
      enabled: true,
      mode: 'tabs',
      sites: ['example.com'],
      assignments: [{ domain: 'example.com', profileId: 'two' }],
      subscriptions: { siteSources: ['youtube'], autoUpdate: false }
    }
  })
  await firefox.send({ command: 'webRTC', value: 'disabled' })
  const chromium = harness('chromium', shared)
  await chromium.flush()
  const received = await chromium.send({ command: 'get' })
  assert.equal(received.syncError, undefined)
  assert.equal(received.warning, 'splitUnsupportedWarning')
  assert.equal(received.state.profiles.length, 2)
  assert.equal(received.state.profiles[1].password, 'secret-two')
  assert.equal(received.state.browserRouting.mode, 'domains')
  for (const values of [
    received.state.browserRouting.sites,
    received.state.browserRouting.assignments,
    received.state.browserRouting.subscriptions.siteSources
  ]) {
    assert.equal(values.length, 0)
  }
  assert.equal(received.state.webRTC, 'browser')
  assert.equal(received.state.activeId, null)

  vm.runInContext(
    "recordStartupError(new Error('errorProxyControl')); syncRevision = undefined",
    chromium.context
  )
  const persist = chromium.api.storage.local.set
  chromium.api.storage.local.set = async () => {
    throw new Error('Storage failure')
  }
  await vm.runInContext('receiveSync()', chromium.context)
  const failed = await chromium.send({ command: 'get' })
  assert.equal(failed.syncError, 'errorSync')
  assert.equal(failed.warning, 'errorProxyControl')
  assert.equal(failed.warningDetails.code, 'errorProxyControl')

  chromium.api.storage.local.set = persist
  await vm.runInContext('receiveSync()', chromium.context)
  const recovered = await chromium.send({ command: 'get' })
  assert.equal(recovered.syncError, undefined)
  assert.equal(recovered.warning, 'splitUnsupportedWarning')
  assert.equal(recovered.warningDetails, undefined)
  await chromium.send({ command: 'language', language: 'en' })
  const cleared = await chromium.send({ command: 'get' })
  assert.equal(cleared.warning, undefined)
  assert.equal(cleared.warningDetails, undefined)
})

test('subscription download overrides are restricted to extension requests on Firefox', async () => {
  for (const target of ['chromium', 'firefox']) {
    const h = harness(target)
    await h.flush()
    vm.runInContext(
      'downloadRouting = { hosts: ["raw.githubusercontent.com"], throughProxy: false }',
      h.context
    )
    for (const [tabId, originUrl, firefoxExpected] of [
      [-1, undefined, true],
      [-1, 'moz-extension://test/background.html', true],
      [-1, 'https://untrusted.example/', false],
      [1, undefined, false]
    ]) {
      const details = { url: 'https://raw.githubusercontent.com/list.txt', tabId, originUrl }
      assert.equal(
        vm.runInContext(`isSubscriptionDownload(${JSON.stringify(details)})`, h.context),
        target === 'chromium' || firefoxExpected
      )
    }
    assert.equal(
      vm.runInContext(
        'isSubscriptionDownload({url: "https://other.example/", tabId: -1})',
        h.context
      ),
      false
    )
  }
})

test('privacy options control native browser settings, release control and reject Firefox-only options on Chromium', async () => {
  for (const target of ['firefox', 'chromium']) {
    const h = harness(target)
    await h.flush()
    assert.equal((await h.send({ command: 'webRTC', value: 'disable_non_proxied_udp' })).ok, true)
    assert.ok(
      h.calls.some(([name, value]) => name === 'policy' && value === 'disable_non_proxied_udp')
    )
    assert.equal((await h.send({ command: 'webRTC', value: 'disabled' })).ok, target === 'firefox')
    assert.equal((await h.send({ command: 'webRTC', value: 'browser' })).ok, true)
    assert.ok(h.calls.some(([name, value]) => name === 'policy' && value === 'clear'))
    h.api.privacy.network.webRTCIPHandlingPolicy.get = async () => ({
      levelOfControl: 'controlled_by_other_extensions'
    })
    assert.equal(
      (await h.send({ command: 'webRTC', value: 'default' })).error,
      'errorPrivacyControl'
    )
    assert.equal((await h.send({ command: 'get' })).state.webRTC, 'browser')
  }
})

test('sync transfers settings and passwords by default, respects opt-out, retains local activation and handles quotas', async () => {
  const shared = {}
  const first = harness('firefox', shared)
  await profiles(first)
  await first.send({ command: 'theme', theme: 'dark' })
  assert.equal(
    (await first.send({ command: 'sync', enabled: true, includePasswords: true })).syncError,
    undefined
  )
  const second = harness('firefox', shared)
  await second.send({ command: 'sync', enabled: true, includePasswords: true })
  const state = (await second.send({ command: 'get' })).state
  assert.equal(state.profiles[1].password, 'secret-two')
  assert.equal(state.theme, 'dark')
  assert.equal(state.activeId, null)
  await first.send({ command: 'sync', enabled: true, includePasswords: false })
  assert.equal(JSON.stringify(shared).includes('secret-'), false)
  const third = harness('firefox', shared)
  await third.send({ command: 'sync', enabled: true, includePasswords: false })
  assert.equal((await third.send({ command: 'get' })).state.profiles[0].password, '')
  first.api.storage.sync.set = async () => {
    throw new Error('quota')
  }
  await first.send({ command: 'language', language: 'ru' })
  const result = await first.send({ command: 'get' })
  assert.equal(result.state.language, 'ru')
  assert.equal(result.syncError, 'errorSync')
  shared.megaConfig = { revision: 'invalid', count: 100000 }
  await second.events.changed({ megaConfig: {} }, 'sync')
  await second.flush()
  assert.equal((await second.send({ command: 'get' })).state.profiles.length, 2)
})

test('context menu actions use the clicked tab and do not register shortcuts', async () => {
  const h = harness()
  await profiles(h)
  assert.ok(h.menus.has('profile:two'))
  await h.events.menu({ menuItemId: 'addCurrentSite' }, { id: 5, url: 'https://clicked.example/' })
  await h.flush()
  assert.deepEqual(Array.from((await h.send({ command: 'get' })).state.browserRouting.domains), [
    '**.clicked.example'
  ])
  await h.events.menu(
    { menuItemId: 'excludeCurrentSite' },
    { id: 5, url: 'https://clicked.example/' }
  )
  await h.flush()
  assert.equal(
    (await h.send({ command: 'testRule', url: 'https://sub.clicked.example/' })).proxied,
    false
  )
  await h.events.menu({ menuItemId: 'settings' }, {})
  await h.flush()
  assert.ok(h.calls.some(([name]) => name === 'options'))
})

test('site exclusions reject knock conflicts and oversized bypass lists before persistence', async () => {
  for (const target of ['chromium', 'firefox']) {
    const h = harness(target)
    await profiles(h)
    for (const [hostname, error] of [
      ['knock.example', 'errorKnockBypass'],
      ['extra.example', 'errorProfileFields']
    ]) {
      if (hostname === 'extra.example') {
        await h.send({
          command: 'save',
          profile: { id: 'one', bypass: Array.from({ length: 1000 }, (_, i) => `b${i}.example`) }
        })
      }
      const before = JSON.stringify(h.stored().state)
      const result = await h.send({
        command: 'excludeCurrentSite',
        tab: { id: 5, url: `https://${hostname}/` }
      })
      assert.equal(result.error, error)
      assert.equal(JSON.stringify(h.stored().state), before)
      for (const profile of (await h.send({ command: 'get' })).state.profiles) {
        assert.doesNotThrow(() => h.context.MegaProxy.profile(profile))
      }
    }
  }
})

test('pending auth is cancelled on disconnect and synchronized credential changes', async () => {
  for (const target of ['chromium', 'firefox']) {
    for (const change of ['direct', 'system', 'activate', 'sync']) {
      const shared = {}
      const h = harness(target, shared)
      await profiles(h)
      const details = {
        requestId: 'r',
        type: 'main_frame',
        tabId: 4,
        isProxy: true,
        challenger: { host: 'proxy.example', port: 443 }
      }
      await new Promise(resolve => h.events.onAuthRequired(details, resolve))
      let response
      h.events.onAuthRequired(details, value => {
        response = value
      })
      await new Promise(setImmediate)
      if (['direct', 'system'].includes(change)) {
        await h.send({ command: 'connectionMode', mode: change })
      } else if (change === 'activate') {
        await h.send({ command: 'activate', id: 'two' })
      } else {
        const sender = harness(target, shared)
        await sender.flush()
        await sender.send({ command: 'save', profile: { id: 'one', password: 'remote-secret' } })
        h.events.changed({ megaConfig: {} }, 'sync')
        await h.flush()
      }
      assert.equal(response?.cancel, true, change)
    }
  }
})

test('current-site and failed-resource actions support IPv6 literals', async () => {
  for (const target of ['chromium', 'firefox']) {
    const h = harness(target)
    await profiles(h)
    const tab = { id: 5, url: 'https://[2001:db8::1]/' }
    assert.equal((await h.send({ command: 'addCurrentSite', tab })).ok, true)
    assert.equal((await h.send({ command: 'testRule', url: tab.url })).proxied, true)
    assert.equal((await h.send({ command: 'excludeCurrentSite', tab })).ok, true)
    assert.equal((await h.send({ command: 'testRule', url: tab.url })).proxied, false)
    await vm.runInContext(
      'countRequest({ tabId: 5, url: "https://[2001:db8::2]/", type: "image" }, true)',
      h.context
    )
    assert.equal(
      (await h.send({ command: 'addFailedDomains', tabId: 5, domains: ['[2001:db8::2]'] })).ok,
      true
    )
    assert.equal(
      (await h.send({ command: 'testRule', url: 'https://[2001:db8::2]/' })).proxied,
      true
    )
  }
})

test('URL import bounds downloads, validates data, rejects unsafe schemes and does not apply before review', async () => {
  const config = {
    schema: 'net.megaproxy487.config',
    version: 8,
    profiles: [{ id: 'remote', proxy: { type: 'HTTPS', host: 'proxy.example', port: 443 } }]
  }
  let response = new Response(JSON.stringify(config))
  const h = harness('chromium', {}, async (_, options) => {
    assert.equal(options.headers['X-MegaProxy-Client'], 'browser_chromium')
    assert.equal(options.headers['X-MegaProxy-Version'], '1.2.3')
    return response
  })
  const downloaded = await h.send({
    command: 'fetchConfig',
    url: 'https://config.example/MegaProxy.json'
  })
  assert.equal(downloaded.ok, true)
  assert.equal((await h.send({ command: 'get' })).state.profiles.length, 0)
  assert.equal((await h.send({ command: 'previewImport', data: downloaded.data })).added, 1)
  assert.equal((await h.send({ command: 'import', data: downloaded.data })).ok, true)
  for (const url of ['file:///tmp/config', 'https://user:password@example.com/']) {
    assert.equal((await h.send({ command: 'fetchConfig', url })).error, 'errorConfigURL')
  }
  response = new Response('x'.repeat(1024 * 1024 + 1))
  assert.equal(
    (await h.send({ command: 'fetchConfig', url: 'https://config.example/' })).error,
    'errorFileSize'
  )
  response = new Response('{}', { status: 500 })
  assert.equal(
    (await h.send({ command: 'fetchConfig', url: 'https://config.example/' })).error,
    'errorConfigDownload'
  )
  response = new Response('{"invalid":true}')
  assert.equal((await h.send({ command: 'fetchConfig', url: 'https://config.example/' })).ok, false)
})

test('default sync supports HTTP/IPv6 profiles and incoming password opt-out preserves local secrets', async () => {
  const shared = {}
  const first = harness('firefox', shared)
  await first.send({
    command: 'save',
    profile: {
      id: 'ipv6',
      type: 'http',
      host: '::1',
      port: 8080,
      username: 'user',
      password: 'remote'
    }
  })
  assert.ok(shared.megaConfig)
  const second = harness('firefox', shared)
  await second.flush()
  let state = (await second.send({ command: 'get' })).state
  assert.equal(state.profiles[0].type, 'http')
  assert.equal(state.profiles[0].host, '::1')
  await second.send({ command: 'sync', enabled: false, includePasswords: false })
  await second.send({ command: 'save', profile: { ...state.profiles[0], password: 'local' } })
  await first.send({ command: 'theme', theme: 'dark' })
  await second.send({ command: 'sync', enabled: true, includePasswords: false })
  state = (await second.send({ command: 'get' })).state
  assert.equal(state.profiles[0].password, 'local')
  assert.equal(state.theme, 'dark')
  assert.equal(JSON.stringify(shared).includes('remote'), false)
})

test('legacy assignment data is validated but cannot select another profile', async () => {
  const h = harness()
  await profiles(h)
  const routing = {
    enabled: true,
    strategy: 'profiles',
    domains: ['**.example.com'],
    assignments: [{ domain: 'example.com', profileId: 'two' }]
  }
  assert.equal(
    (
      await h.send({
        command: 'routing',
        routing: { ...routing, assignments: [...routing.assignments, ...routing.assignments] }
      })
    ).ok,
    false
  )
  assert.equal((await h.send({ command: 'routing', routing })).ok, true)
  const state = (await h.send({ command: 'get' })).state
  assert.equal(state.browserRouting.strategy, 'manual')
  assert.equal(state.browserRouting.assignments.length, 0)
  assert.equal(
    (await h.send({ command: 'testRule', url: 'https://child.example.com/' })).profile.id,
    'one'
  )
})

test('sync rejects oversized payloads and incomplete snapshots without losing local configuration', async () => {
  const shared = {}
  const h = harness('firefox', shared)
  await profiles(h)
  const before = shared.megaConfig.revision
  const result = await h.send({
    command: 'save',
    profile: {
      id: 'large',
      host: 'large.example',
      port: 443,
      bypass: Array.from(
        { length: 500 },
        (_, i) => `${i}.${'x'.repeat(60)}.${'y'.repeat(60)}.example`
      )
    }
  })
  assert.equal(result.ok, true)
  assert.equal(result.syncError, 'errorSyncSize')
  assert.equal(shared.megaConfig.revision, before)
  assert.equal((await h.send({ command: 'get' })).state.profiles.length, 3)
  shared.megaConfig = { revision: 'incomplete', count: 2 }
  shared['mega:incomplete:0'] = '{'
  h.events.changed({ megaConfig: {} }, 'sync')
  await h.flush()
  assert.equal((await h.send({ command: 'get' })).state.profiles.length, 3)
  assert.equal((await h.send({ command: 'get' })).syncError, 'errorSync')
})

test('sync reproduces profile order and malformed rules and URL downloads have localized errors', async () => {
  const shared = {}
  const first = harness('firefox', shared)
  await profiles(first)
  const second = harness('firefox', shared)
  await second.flush()
  await first.send({ command: 'move', id: 'two', direction: -1 })
  second.events.changed({ megaConfig: {} }, 'sync')
  await second.flush()
  assert.deepEqual(
    Array.from((await second.send({ command: 'get' })).state.profiles, p => p.id),
    ['two', 'one']
  )
  assert.equal((await first.send({ command: 'testRule', url: 'broken' })).error, 'errorRuleURL')
  const offline = harness('chromium', {}, async () => {
    throw new Error('offline')
  })
  assert.equal(
    (await offline.send({ command: 'fetchConfig', url: 'https://example.com/' })).error,
    'errorConfigDownload'
  )
})

test('privacy permission denial and partial native failures preserve the previous preference', async () => {
  const h = harness()
  await h.flush()
  h.api.permissions.contains = async () => false
  assert.equal(
    (await h.send({ command: 'webRTC', value: 'disabled' })).error,
    'errorPrivacyPermission'
  )
  h.api.permissions.contains = async () => true
  h.api.privacy.network.peerConnectionEnabled.set = async () => {
    throw new Error('native failure')
  }
  assert.equal((await h.send({ command: 'webRTC', value: 'disabled' })).ok, false)
  assert.equal((await h.send({ command: 'get' })).state.webRTC, 'browser')
  assert.ok(h.calls.some(([key, value]) => key === 'policy' && value === 'clear'))
})

test('failed privacy persistence rolls back native settings and failed sync publication removes orphan chunks', async () => {
  const h = harness()
  await h.flush()
  h.api.storage.local.set = async () => {
    throw new Error('disk failure')
  }
  assert.equal((await h.send({ command: 'webRTC', value: 'disabled' })).ok, false)
  assert.equal((await h.send({ command: 'get' })).state.webRTC, 'browser')
  const shared = {}
  const other = harness('firefox', shared)
  await profiles(other)
  const previous = JSON.stringify(shared)
  other.api.storage.sync.set = async value => {
    if (value.megaConfig) {
      throw new Error('pointer quota')
    }
    Object.assign(shared, value)
  }
  await other.send({ command: 'theme', theme: 'dark' })
  assert.equal(JSON.stringify(shared), previous)
  assert.equal((await other.send({ command: 'get' })).state.theme, 'dark')
})

test('domain routing uses only the selected profile and agrees with Chromium PAC', async () => {
  for (const target of ['firefox', 'chromium']) {
    const h = harness(target)
    await profiles(h)
    await h.send({ command: 'routing', routing: { enabled: true, domains: ['**.example.com'] } })
    for (const id of ['one', 'two']) {
      await h.send({ command: 'activate', id })
      const state = (await h.send({ command: 'get' })).state
      const p = state.profiles.find(p => p.id === id)
      const pac = vm.createContext({})
      vm.runInContext(h.context.MegaProxy.chromiumConfig(p, state).pacScript.data, pac)
      for (const domain of ['example.com', 'child.example.com', 'elsewhere.example']) {
        const url = `https://${domain}/asset`
        const proxied = domain.endsWith('example.com')
        assert.equal(
          (await h.send({ command: 'testRule', url })).profile?.id || null,
          proxied ? id : null
        )
        assert.equal(pac.FindProxyForURL(url, domain), proxied ? `HTTPS ${p.host}:443` : 'DIRECT')
      }
    }
    await h.send({ command: 'connectionMode', mode: 'direct' })
    assert.equal(
      (await h.send({ command: 'testRule', url: 'https://example.com/' })).proxied,
      false
    )
  }
})

test('network monitor is bounded, private, opt-out, and does not write storage per resource', async () => {
  const h = harness()
  await profiles(h)
  assert.equal((await h.send({ command: 'get' })).state.statisticsEnabled, true)
  const telemetry = await h.send({ command: 'telemetry' })
  assert.equal(telemetry.statistics.completed, 0)
  assert.equal(telemetry.state, undefined)
  await h.send({ command: 'routing', routing: { enabled: true, strategy: 'manual', domains: [] } })
  const writes = h.calls.filter(([kind]) => kind === 'storage').length
  for (let i = 0; i < 260; i++) {
    await vm.runInContext(
      `countRequest(${JSON.stringify({ tabId: 1, url: `https://failed.example/path?secret=${i}`, type: 'script', error: 'NS_ERROR_FAILURE' })}, true)`,
      h.context
    )
  }
  const rows = (await h.send({ command: 'network', tabId: 1 })).entries
  assert.equal(rows.length, 200)
  assert.equal(rows[0].domain, 'failed.example')
  assert.equal(JSON.stringify(rows).includes('secret'), false)
  assert.equal(h.calls.filter(([kind]) => kind === 'storage').length, writes)
  assert.equal(
    (await h.send({ command: 'addFailedDomains', tabId: 1, domains: ['unobserved.example'] })).ok,
    false
  )
  assert.equal(
    (
      await h.send({
        command: 'addFailedDomains',
        tabId: 1,
        domains: ['failed.example'],
        profileId: 'two'
      })
    ).ok,
    true
  )
  assert.equal(
    (await h.send({ command: 'testRule', url: 'https://sub.failed.example/' })).profile.id,
    'one'
  )
  await h.send({ command: 'statistics', enabled: false })
  await vm.runInContext(
    'countRequest({ tabId: 1, url: "https://failed.example/" }, true)',
    h.context
  )
  assert.equal((await h.send({ command: 'network', tabId: 1 })).entries.length, 0)
  assert.equal((await h.send({ command: 'get' })).statistics, undefined)
  await h.send({ command: 'statistics', enabled: true })
  for (let tabId = 1; tabId <= 55; tabId++) {
    await vm.runInContext(
      `countRequest({ tabId: ${tabId}, url: "https://failed.example/", type: "image" }, false)`,
      h.context
    )
  }
  assert.equal(vm.runInContext('networkLog.size', h.context), 50)
  h.events.removed(55)
  assert.equal((await h.send({ command: 'network', tabId: 55 })).entries.length, 0)
  h.events.updated(54, { url: 'https://next.example/' })
  assert.equal((await h.send({ command: 'network', tabId: 54 })).entries.length, 0)
})

test('ZeroOmega imports compatible profiles and domain rules with warnings for unsupported settings', async () => {
  const h = harness()
  const data = {
    schemaVersion: 2,
    '+proxy': {
      name: 'proxy',
      profileType: 'FixedProfile',
      fallbackProxy: { scheme: 'https', host: 'proxy.example', port: 443 },
      auth: { all: { username: 'user', password: 'secret' } },
      bypassList: [{ conditionType: 'BypassCondition', pattern: 'internal.example' }]
    },
    '+socks': {
      name: 'socks',
      profileType: 'FixedProfile',
      fallbackProxy: { scheme: 'socks5', host: 'socks.example', port: 1080 }
    },
    '+alias': { name: 'alias', profileType: 'VirtualProfile', defaultProfileName: 'proxy' },
    '+auto': {
      name: 'auto',
      profileType: 'SwitchProfile',
      defaultProfileName: 'direct',
      rules: [
        {
          condition: { conditionType: 'HostWildcardCondition', pattern: '*.example.com' },
          profileName: 'alias'
        },
        {
          condition: { conditionType: 'HostWildcardCondition', pattern: 'exact.example.org' },
          profileName: 'proxy'
        },
        {
          condition: { conditionType: 'HostWildcardCondition', pattern: '*.direct.example' },
          profileName: 'direct'
        },
        { condition: { conditionType: 'UrlRegexCondition', pattern: '.*' }, profileName: 'proxy' }
      ]
    }
  }
  const preview = await h.send({ command: 'previewImport', data })
  assert.equal(preview.added, 2)
  assert.deepEqual(JSON.parse(JSON.stringify(preview.skipped)), [])
  assert.equal(preview.unknownFields, true)
  assert.equal((await h.send({ command: 'get' })).state.profiles.length, 0)
  await h.send({ command: 'import', data: JSON.stringify(data) })
  const state = (await h.send({ command: 'get' })).state
  assert.equal(state.profiles[0].password, 'secret')
  assert.equal(state.activeId, null)
  await h.send({ command: 'activate', id: 'zero:proxy' })
  for (const [url, proxied] of [
    ['https://example.com/', true],
    ['https://child.example.com/', true],
    ['https://exact.example.org/', true],
    ['https://child.exact.example.org/', false],
    ['https://direct.example/', false]
  ]) {
    assert.equal((await h.send({ command: 'testRule', url })).proxied, proxied)
  }
})

test('concurrent sync publishers never delete another in-flight snapshot', async () => {
  const shared = {}
  const a = harness('firefox', shared)
  const b = harness('firefox', shared)
  await a.flush()
  await b.flush()
  let release, written
  const blocked = new Promise(resolve => {
    release = resolve
  })
  const chunksWritten = new Promise(resolve => {
    written = resolve
  })
  b.api.storage.sync.set = async value => {
    if (value.megaConfig) {
      await blocked
    }
    Object.assign(shared, structuredClone(value))
    if (!value.megaConfig) {
      written()
    }
  }
  const pending = b.send({ command: 'save', profile: { id: 'b', host: 'b.example', port: 443 } })
  await chunksWritten
  try {
    await a.send({ command: 'save', profile: { id: 'a', host: 'a.example', port: 443 } })
  } finally {
    release()
  }
  await pending
  const receiver = harness('firefox', shared)
  await receiver.flush()
  const result = await receiver.send({ command: 'get' })
  assert.equal(result.syncError, undefined)
  assert.equal(result.state.profiles[0].id, 'b')
})

test('pending monitor completions cannot resurrect closed, navigated or cleared journals', async () => {
  for (const invalidation of ['close', 'navigate', 'clear', 'disable']) {
    const h = harness()
    await profiles(h)
    await h.send({
      command: 'routing',
      routing: { enabled: true, mode: 'tabs', sites: ['old.example'] }
    })
    let release
    h.api.tabs.get = () =>
      new Promise(resolve => {
        release = resolve
      })
    const pending = vm.runInContext(
      'countRequest({ tabId: 1, url: "https://old.example/", type: "image" }, true)',
      h.context
    )
    if (invalidation === 'close') {
      h.events.removed(1)
    }
    if (invalidation === 'navigate') {
      h.events.updated(1, { url: 'https://new.example/' })
    }
    if (invalidation === 'clear') {
      await vm.runInContext('handle({command: "clearNetwork"})', h.context)
    }
    if (invalidation === 'disable') {
      await h.send({ command: 'statistics', enabled: false })
    }
    release({ url: 'https://old.example/' })
    await pending
    assert.equal((await h.send({ command: 'network', tabId: 1 })).entries.length, 0, invalidation)
    if (invalidation === 'close') {
      assert.equal(vm.runInContext('tabUrls.has(1)', h.context), false)
    }
    if (invalidation === 'navigate') {
      assert.equal(vm.runInContext('tabUrls.get(1)', h.context), 'https://new.example/')
    }
  }
})

test('worker startup restores abandoned assigned-knock routing before clearing its lease', async () => {
  const initial = {
    session: { assignedKnockLease: true },
    state: {
      activeId: 'one',
      profiles: [
        {
          id: 'one',
          host: 'proxy.example',
          port: 443,
          username: 'user',
          password: 'secret',
          knockHost: 'knock.example'
        }
      ]
    }
  }
  const failed = harness('chromium', {}, globalThis.fetch, initial)
  failed.api.proxy.settings.set = async () => {
    throw new Error('native restore failed')
  }
  await failed.flush()
  assert.equal((await failed.send({ command: 'get' })).warning, 'native restore failed')
  assert.equal(initial.session.assignedKnockLease, true)
  const h = harness('chromium', {}, globalThis.fetch, initial)
  await h.flush()
  const native = h.calls.find(([kind]) => kind === 'proxy')[1].value
  assert.equal(native.mode, 'fixed_servers')
  assert.equal(native.rules.singleProxy.host, 'proxy.example')
  assert.equal(initial.session.assignedKnockLease, false)
})

test('ZeroOmega edge cases preserve rule order, bound references and reject malformed settings', () => {
  const h = harness()
  const core = h.context.MegaProxy
  const fixed = (name, endpoint = {}) => ({
    name,
    profileType: 'FixedProfile',
    fallbackProxy: { scheme: 'https', host: `${name}.proxy.example`, port: 443, ...endpoint }
  })
  const rule = (pattern, profileName) => ({
    condition: { conditionType: 'HostWildcardCondition', pattern },
    profileName
  })
  const config = rules => ({
    schemaVersion: 2,
    '+one': fixed('one'),
    '+two': fixed('two'),
    '+auto': { name: 'auto', profileType: 'SwitchProfile', defaultProfileName: 'direct', rules }
  })
  const select = (data, hostname) => {
    const imported = core.importProfiles(data)
    const state = {
      ...core.defaults(),
      profiles: imported.profiles,
      activeId: 'zero:one',
      browserRouting: imported.browserRouting
    }
    return {
      imported,
      profile: core.routed(`https://${hostname}/`, state)
        ? core.routeProfile(`https://${hostname}/`, state)?.id
        : 'DIRECT'
    }
  }
  // First-match parent shadows its child; the reverse order keeps the child override.
  let result = select(
    config([rule('*.example.com', 'one'), rule('child.example.com', 'two')]),
    'child.example.com'
  )
  assert.equal(result.profile, 'zero:one')
  assert.equal(result.imported.unknownFields, true)
  result = select(
    config([rule('child.example.com', 'two'), rule('*.example.com', 'one')]),
    'child.example.com'
  )
  assert.equal(result.profile, 'zero:one')
  assert.equal(
    select(
      config([rule('child.example.com', 'two'), rule('*.example.com', 'one')]),
      'sub.child.example.com'
    ).profile,
    'zero:one'
  )
  const cyclic = config([rule('*.example.com', 'alias')])
  cyclic['+alias'] = { profileType: 'VirtualProfile', defaultProfileName: 'loop' }
  cyclic['+loop'] = { profileType: 'VirtualProfile', defaultProfileName: 'alias' }
  assert.equal(select(cyclic, 'example.com').profile, 'DIRECT')
  assert.equal(core.importProfiles(cyclic).unknownFields, true)
  const protocols = config([])
  protocols['+two'].proxyForHttp = { scheme: 'http', host: 'different.example', port: 8080 }
  assert.deepEqual(Array.from(core.importProfiles(protocols).skipped), ['two'])
  const credentials = config([])
  credentials['+two'].proxyForHttp = { ...credentials['+two'].fallbackProxy }
  credentials['+two'].auth = {
    all: { username: 'a', password: 'one' },
    proxyForHttp: { username: 'b', password: 'two' }
  }
  assert.deepEqual(Array.from(core.importProfiles(credentials).skipped), ['two'])
  const switches = config([rule('one.example', 'one')])
  switches['+other'] = {
    name: 'other',
    profileType: 'SwitchProfile',
    defaultProfileName: 'direct',
    rules: [rule('two.example', 'two')]
  }
  switches['-startupProfileName'] = 'other'
  assert.equal(select(switches, 'two.example').profile, 'zero:one')
  assert.equal(select(switches, 'one.example').profile, 'DIRECT')
  assert.equal(core.importProfiles(switches).unknownFields, true)
  for (const [mutate, error] of [
    [
      data => {
        data.schemaVersion = 3
      },
      'errorImport'
    ],
    [
      data => {
        data['+auto'].rules = 'invalid'
      },
      'errorImport'
    ],
    [
      data => {
        data['+one'].bypassList = 'invalid'
      },
      'errorProfileFields'
    ],
    [
      data => {
        data['+two'].name = 'one'
      },
      'errorDuplicateIds'
    ],
    [
      data => {
        data['+auto'].rules = [null]
      },
      'errorImport'
    ]
  ]) {
    const data = config([])
    mutate(data)
    assert.throws(() => core.importProfiles(data), { message: error })
  }
})

test('Chromium migrates automatic themes to dark while Firefox retains automatic preference', async () => {
  for (const target of ['chromium', 'firefox']) {
    const h = harness(target, {}, undefined, { state: { theme: 'system' } })
    const expected = target === 'chromium' ? 'dark' : 'system'
    assert.equal((await h.send({ command: 'get' })).state.theme, expected)
    assert.equal((await h.send({ command: 'theme', theme: 'light' })).state.theme, 'light')
    assert.equal((await h.send({ command: 'theme', theme: 'system' })).state.theme, expected)
  }
})

test('removed failover mode migrates to Proxy and network errors never select another profile', async () => {
  for (const target of ['chromium', 'firefox']) {
    const h = harness(target, {}, globalThis.fetch, {
      state: {
        profiles: [
          { id: 'one', host: 'proxy.example', port: 443 },
          { id: 'two', host: 'other.example', port: 443 }
        ],
        activeId: 'two',
        connectionMode: 'failover',
        failoverMode: 'ALL',
        failoverProfileIds: ['one']
      }
    })
    await h.flush()
    let state = (await h.send({ command: 'get' })).state
    assert.equal(state.connectionMode, 'proxy')
    assert.equal(state.activeId, 'two')
    assert.equal(Object.hasOwn(state, 'failoverMode'), false)
    assert.equal(h.stored().state.connectionMode, 'proxy')
    for (const type of ['main_frame', 'xmlhttprequest', 'image']) {
      h.events.onErrorOccurred({
        type,
        tabId: 1,
        url: 'https://yandex.ru/internet',
        error: 'NS_ERROR_PROXY_CONNECTION_REFUSED'
      })
    }
    await h.flush()
    state = (await h.send({ command: 'get' })).state
    assert.equal(state.activeId, 'two')
    assert.equal(state.connectionMode, 'proxy')
    assert.equal((await h.send({ command: 'connectionMode', mode: 'failover' })).ok, false)
    assert.equal((await h.send({ command: 'failover', mode: 'ALL', ids: [] })).ok, false)
    const exported = (await h.send({ command: 'export', includePasswords: true })).config
    const input = structuredClone(exported)
    input.failover = { mode: 'ALL', profileIds: ['one'] }
    const preview = await h.send({ command: 'previewImport', data: JSON.stringify(input) })
    assert.equal(preview.unknownFields, true)
    await h.send({ command: 'import', data: JSON.stringify(input) })
    assert.equal((await h.send({ command: 'export' })).config.failover, undefined)
    assert.equal((await h.send({ command: 'get' })).state.activeId, 'two')
  }
})

test('stored legacy routing is normalized, persisted and reapplied before stale PAC can route another profile', async () => {
  for (const target of ['chromium', 'firefox']) {
    const initial = {
      state: {
        profiles: [
          { id: 'one', host: 'proxy.example', port: 443 },
          { id: 'two', host: 'other.example', port: 443 }
        ],
        activeId: 'one',
        connectionMode: 'proxy',
        browserRouting: {
          enabled: true,
          strategy: 'profiles',
          domains: ['**.example.com'],
          assignments: [{ domain: 'example.com', profileId: 'two' }]
        }
      }
    }
    const h = harness(target, {}, undefined, initial)
    await h.flush()
    const current = (await h.send({ command: 'get' })).state
    assert.equal(current.browserRouting.strategy, 'manual')
    assert.equal(current.browserRouting.assignments.length, 0)
    assert.equal(h.stored().state.browserRouting.assignments.length, 0)
    assert.equal(
      (await h.send({ command: 'testRule', url: 'https://child.example.com/' })).profile.id,
      'one'
    )
    if (target === 'chromium') {
      const pac = vm.createContext({})
      vm.runInContext(h.calls.find(([name]) => name === 'proxy')[1].value.pacScript.data, pac)
      assert.equal(
        pac.FindProxyForURL('https://child.example.com/', 'child.example.com'),
        'HTTPS proxy.example:443'
      )
    }
  }
})

test('failed domains extend only manual lists or Firefox tab-site lists without changing routing mode', async () => {
  const h = harness('firefox')
  await profiles(h)
  await vm.runInContext(
    'countRequest({ tabId: 1, url: "https://failed.example/asset", type: "script" }, true)',
    h.context
  )
  for (const strategy of ['manual', 'tabs', 'lists', 'all']) {
    await h.send({
      command: 'routing',
      routing: {
        enabled: strategy !== 'all',
        strategy: strategy === 'all' ? 'manual' : strategy,
        domains: ['existing.example'],
        sites: ['existing-tab.example']
      }
    })
    const result = await h.send({
      command: 'addFailedDomains',
      tabId: 1,
      domains: ['failed.example']
    })
    assert.equal(result.ok, ['manual', 'tabs'].includes(strategy))
    if (result.ok) {
      const routing = result.state.browserRouting
      assert.equal(routing.strategy, strategy)
      assert.equal(routing.mode, strategy === 'tabs' ? 'tabs' : 'domains')
      assert.equal(
        routing[strategy === 'tabs' ? 'sites' : 'domains'].includes('**.failed.example'),
        true
      )
      assert.equal(
        routing[strategy === 'tabs' ? 'domains' : 'sites'].includes('**.failed.example'),
        false
      )
    }
  }
})

test('background errors identify downloads, HTTP status, timeout and read-only operations without secrets', async () => {
  let failure = new TypeError('Failed to fetch')
  const h = harness('chromium', {}, async () => {
    throw failure
  })
  const message = { command: 'fetchConfig', url: 'https://config.example/?token=private-token' }
  let response = await h.send(message)
  assert.deepEqual(JSON.parse(JSON.stringify(response.errorDetails)), {
    operation: 'fetchConfig',
    code: 'errorConfigDownload',
    reason: 'errorNetwork'
  })
  failure = new DOMException('private-secret', 'TimeoutError')
  response = await h.send(message)
  assert.equal(response.errorDetails.reason, 'TimeoutError')
  assert.ok(!JSON.stringify(response.errorDetails).includes('private'))
  const http = harness('chromium', {}, async () => new Response('', { status: 403 }))
  response = await http.send(message)
  assert.equal(response.errorDetails.status, 403)
  assert.equal(response.errorDetails.reason, 'errorHTTP')
  const invalid = await h.send({
    command: 'save',
    profile: { host: 'proxy.example', port: 443, color: -1 }
  })
  assert.equal(invalid.errorDetails.reason, 'errorProfileColor')
  h.api.tabs.query = async () => {
    throw new Error('private-secret')
  }
  response = await h.send({ command: 'currentSite' })
  assert.equal(response.ok, false)
  assert.equal(response.errorDetails.operation, 'currentSite')
  assert.equal(response.errorDetails.code, 'errorUnexpected')
})

test('proxy auth dialog focuses once, retries rejected credentials, and saves only confirmed credentials', async () => {
  for (const target of ['chromium', 'firefox']) {
    const h = harness(target, {}, undefined, {
      state: {
        profiles: [
          {
            id: 'p',
            name: 'Proxy',
            host: 'proxy.example',
            port: 443,
            username: 'old',
            password: 'old-secret'
          }
        ],
        activeId: 'p'
      }
    })
    await h.flush()
    const details = {
      requestId: 'r',
      tabId: 4,
      type: 'main_frame',
      url: 'https://knock.example/',
      isProxy: true,
      challenger: { host: 'proxy.example', port: 443 }
    }
    const challenge = extra =>
      new Promise(resolve => h.events.onAuthRequired({ ...details, ...extra }, resolve))
    assert.equal((await challenge()).authCredentials.password, 'old-secret')
    const waiting = challenge()
    await new Promise(setImmediate)
    const opened = h.calls.find(([event]) => event === 'authWindow')[1]
    assert.equal(opened.focused, true)
    assert.equal(opened.type, 'popup')
    const token = new URL(opened.url).searchParams.get('id')
    const send = command =>
      new Promise(resolve =>
        h.events.message({ token, ...command }, { id: 'test', url: opened.url }, resolve)
      )
    assert.equal(
      h.events.message(
        { command: 'authGet', token },
        { id: 'test', url: 'https://evil.example/' },
        () => assert.fail()
      ),
      false
    )
    assert.equal(
      h.events.message(
        { command: 'authSubmit', token },
        { id: 'test', url: h.api.runtime.getURL('options.html') },
        () => assert.fail()
      ),
      false
    )
    assert.ok(!JSON.stringify(await send({ command: 'authGet' })).includes('old-secret'))
    const sibling = await challenge({ requestId: 'sibling', type: 'image' })
    assert.equal(sibling.cancel, true)
    assert.equal(h.calls.filter(([event]) => event === 'authWindow').length, 1)
    assert.equal(
      (await send({ command: 'authSubmit', username: 'new', password: 'wrong' })).ok,
      true
    )
    assert.equal((await waiting).authCredentials.password, 'wrong')
    assert.equal((await h.send({ command: 'get' })).state.profiles[0].password, 'old-secret')
    const retry = challenge()
    await new Promise(setImmediate)
    assert.equal((await send({ command: 'authGet' })).auth.phase, 'rejected')
    assert.ok(h.calls.some(([event, , options]) => event === 'focusWindow' && options.focused))
    await send({ command: 'authSubmit', username: 'new', password: 'correct' })
    assert.equal((await retry).authCredentials.password, 'correct')
    assert.equal((await h.send({ command: 'get' })).state.profiles[0].password, 'old-secret')
    h.events.onCompleted({ ...details, statusCode: 200 })
    await h.flush()
    assert.equal((await send({ command: 'authGet' })).auth.phase, 'saved')
    assert.equal(h.stored().state.profiles[0].username, 'new')
    assert.equal(h.stored().state.profiles[0].password, 'correct')
    assert.ok(!JSON.stringify(await send({ command: 'authGet' })).includes('correct'))
  }
})

test('cancelling or failing proxy verification never persists candidate credentials or origin credentials', async () => {
  for (const scenario of ['cancel', 'cancelAfterSubmit', 'network', 'profileChanged', 'storage']) {
    const h = harness('chromium', {}, undefined, {
      state: {
        profiles: [
          { id: 'p', host: 'proxy.example', port: 443, username: 'old', password: 'old-secret' }
        ],
        activeId: 'p'
      }
    })
    await h.flush()
    const details = {
      requestId: 'r',
      type: 'main_frame',
      tabId: 4,
      isProxy: true,
      challenger: { host: 'proxy.example', port: 443 }
    }
    const supplied = await new Promise(resolve => h.events.onAuthRequired(details, resolve))
    assert.equal(supplied.authCredentials.password, 'old-secret')
    const response = new Promise(resolve => h.events.onAuthRequired(details, resolve))
    await new Promise(setImmediate)
    const url = h.calls.find(([event]) => event === 'authWindow')[1].url
    const token = new URL(url).searchParams.get('id')
    const send = message =>
      new Promise(resolve => h.events.message({ token, ...message }, { id: 'test', url }, resolve))
    if (scenario === 'cancel') {
      h.events.windowRemoved(8)
      assert.equal((await response).cancel, true)
    } else {
      await send({ command: 'authSubmit', username: 'new', password: 'private-secret' })
      assert.equal((await response).authCredentials.password, 'private-secret')
      if (scenario === 'cancelAfterSubmit') {
        h.events.windowRemoved(8)
      }
      if (scenario === 'profileChanged') {
        await h.send({
          command: 'save',
          profile: { id: 'p', host: 'different.example', port: 443 }
        })
      }
      if (scenario === 'storage') {
        h.api.storage.local.set = async () => {
          throw new DOMException('private-secret', 'QuotaExceededError')
        }
      }
      if (scenario === 'network') {
        h.events.onErrorOccurred({ ...details, error: 'net::ERR_CONNECTION_RESET' })
      } else {
        h.events.onCompleted({ ...details, statusCode: 200 })
      }
    }
    await h.flush()
    if (scenario === 'network') {
      assert.equal((await send({ command: 'authGet' })).auth.phase, 'failed')
    }
    assert.equal((await h.send({ command: 'get' })).state.profiles[0].password, 'old-secret')
    assert.ok(!JSON.stringify(await send({ command: 'authGet' })).includes('private-secret'))
    const origin = await new Promise(resolve =>
      h.events.onAuthRequired({ ...details, isProxy: false }, resolve)
    )
    assert.deepEqual(JSON.parse(JSON.stringify(origin)), {})
  }
})

test('config download exposes sanitized 5xx body in background errors', async () => {
  let attempts = 0
  const h = harness('chromium', {}, async () => {
    attempts++
    return new Response('configuration service down; token=private-token', { status: 500 })
  })
  const response = await h.send({
    command: 'fetchConfig',
    url: 'https://config.example/?token=private-token'
  })
  assert.equal(response.errorDetails.status, 500)
  assert.match(response.errorDetails.responseBody, /configuration service down/)
  assert.doesNotMatch(response.errorDetails.responseBody, /private-token/)
  assert.equal(attempts, 3)
})

test('config downloads retry only 5xx with backoff and stop after success', async () => {
  const config = JSON.stringify({
    schema: 'net.megaproxy487.config',
    version: 8,
    profiles: [{ id: 'remote', proxy: { type: 'HTTPS', host: 'proxy.example', port: 443 } }]
  })
  for (const scenario of ['success', 'forbidden', 'network']) {
    let attempts = 0
    const waits = []
    const h = harness('chromium', {}, async () => {
      attempts++
      if (scenario === 'network') {
        throw new TypeError('Failed to fetch')
      }
      return scenario === 'forbidden'
        ? new Response('', { status: 403 })
        : attempts < 3
          ? new Response('temporarily unavailable', { status: attempts === 1 ? 500 : 503 })
          : new Response(config)
    })
    h.context.setTimeout = (callback, milliseconds) => {
      waits.push(milliseconds)
      callback()
    }
    const response = await h.send({ command: 'fetchConfig', url: 'https://config.example/' })
    assert.equal(response.ok, scenario === 'success')
    assert.equal(attempts, scenario === 'success' ? 3 : 1)
    assert.deepEqual(waits, scenario === 'success' ? [1000, 2000] : [])
    if (response.ok) {
      assert.equal(response.data, config)
    }
  }
})

test('config subscriptions authenticate, replace owned profiles atomically and resume after restart', async () => {
  const alarms = new Map()
  let onAlarm
  let remote
  let requests = 0
  const fetch = async (url, options) => {
    requests++
    assert.equal(url, 'https://config.example/MegaProxy.json')
    assert.equal(
      options.headers.Authorization,
      `Basic ${Buffer.from('читатель:пароль').toString('base64')}`
    )
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers['X-MegaProxy-Client'], 'browser_firefox')
    assert.equal(options.headers['X-MegaProxy-Version'], '1.2.3')
    assert.equal(options.credentials, 'omit')
    return new Response(typeof remote === 'string' ? remote : JSON.stringify(remote), {
      status: typeof remote === 'string' ? 401 : 200
    })
  }
  const alarmAPI = {
    create: async (name, options) => alarms.set(name, options),
    clear: async name => alarms.delete(name),
    get: async name => alarms.get(name),
    onAlarm: {
      addListener: listener => {
        onAlarm = listener
      }
    }
  }
  const h = harness('firefox', {}, fetch, { alarms: alarmAPI })
  const config = {
    schema: 'net.megaproxy487.config',
    version: 8,
    subscription: {
      url: 'https://config.example/MegaProxy.json',
      username: 'читатель',
      password: 'пароль',
      intervalMinutes: 15
    },
    profiles: ['one', 'gone'].map(id => ({
      id,
      proxy: { type: 'HTTPS', host: `${id}.example`, port: 443 }
    }))
  }
  remote = {
    ...config,
    subscription: { ...config.subscription, futureOption: true },
    browser: {
      routing: {
        strategy: 'failover',
        assignments: [{ domain: 'example.com', profileId: 'one' }]
      }
    },
    profiles: [
      config.profiles[0],
      { id: 'new', proxy: { type: 'HTTPS', host: 'new.example', port: 443 } }
    ]
  }
  assert.equal((await h.send({ command: 'import', data: config })).ok, true)
  assert.equal(alarms.get('configSubscription').periodInMinutes, 15)
  assert.equal((await h.send({ command: 'configSubscription', intervalMinutes: 30 })).ok, true)
  assert.equal(alarms.get('configSubscription').periodInMinutes, 30)
  assert.equal((await h.send({ command: 'configSubscription', intervalMinutes: 0 })).ok, false)
  assert.equal(alarms.get('configSubscription').periodInMinutes, 30)
  await h.send({ command: 'save', profile: { id: 'local', host: 'local.example', port: 443 } })
  await h.send({ command: 'activate', id: 'one' })
  await h.send({ command: 'connectionMode', mode: 'direct' })
  onAlarm({ name: 'configSubscription' })
  await h.flush()
  let state = (await h.send({ command: 'get' })).state
  assert.deepEqual(
    Array.from(state.profiles, p => p.id),
    ['one', 'local', 'new']
  )
  assert.equal(state.activeId, 'one')
  assert.equal(state.connectionMode, 'direct')
  assert.equal(state.subscription.password, 'пароль')
  assert.ok(state.configSubscriptionState.lastUpdated)
  assert.equal(state.configSubscriptionState.error, undefined)
  assert.equal(state.configSubscriptionState.unknownFields, true)
  assert.equal(state.subscription.futureOption, undefined)
  assert.equal(state.portable.browser.routing.strategy, 'manual')
  assert.equal(state.portable.browser.routing.assignments.length, 0)
  const snapshot = JSON.stringify(state.profiles)
  for (const invalid of [
    'Access denied',
    { schema: config.schema, version: 8, profiles: [] },
    {
      schema: config.schema,
      version: 8,
      profiles: [{ id: 'unsupported', proxy: { type: 'SSH', host: 'ssh.example', port: 22 } }]
    }
  ]) {
    remote = invalid
    await h.send({ command: 'updateConfigSubscription' })
    state = (await h.send({ command: 'get' })).state
    assert.equal(JSON.stringify(state.profiles), snapshot)
    assert.ok(state.configSubscriptionState.error)
  }
  const failed = structuredClone(state)
  failed.configSubscriptionState.lastAttempt = 0
  remote = { ...config, profiles: [config.profiles[0]] }
  const restarted = harness('firefox', {}, fetch, { state: failed, alarms: alarmAPI })
  await restarted.flush()
  state = (await restarted.send({ command: 'get' })).state
  assert.deepEqual(
    Array.from(state.profiles, p => p.id),
    ['one', 'local']
  )
  assert.equal(state.configSubscriptionState.error, undefined)
  const count = requests
  await restarted.send({ command: 'configSubscription', enabled: false })
  onAlarm({ name: 'configSubscription' })
  await restarted.flush()
  assert.equal(requests, count)
  assert.equal(alarms.has('configSubscription'), false)
  assert.equal(
    (
      await restarted.send({
        command: 'fetchConfig',
        url: 'http://config.example/',
        auth: { username: 'reader', password: 'secret' }
      })
    ).error,
    'errorConfigURL'
  )
  assert.equal(requests, count)
  const synced = harness('firefox', restarted.shared)
  await synced.send({ command: 'get' })
  await synced.flush()
  assert.equal((await synced.send({ command: 'get' })).state.subscription, undefined)
})

test('legacy subscription snapshots reuse profiles and replace only settings represented by their format', async () => {
  const feeds = [
    {
      name: 'LegacyMegaProxy',
      data: {
        schema: 'net.megaproxy487.config',
        version: 6,
        profiles: [
          {
            name: 'Feed',
            proxy: {
              type: 'HTTPS',
              host: 'proxy.example',
              port: 443,
              username: 'user',
              password: 'secret'
            }
          }
        ]
      }
    },
    { name: 'ProxyList', data: 'https://user:secret@proxy.example:443?title=Feed' },
    {
      name: 'FoxyProxy',
      data: {
        data: [
          {
            type: 'ssl',
            address: 'proxy.example',
            port: '443',
            title: 'Feed',
            username: 'user',
            password: 'secret'
          },
          { type: 'pac', title: 'Unsupported PAC' }
        ]
      }
    },
    {
      name: 'SuperProxy',
      data: [
        {
          title: 'Feed',
          proxy: {
            type: 'HTTPS',
            host: 'proxy.example',
            port: 443,
            username: 'user',
            password: 'secret'
          }
        }
      ]
    },
    {
      name: 'ZeroOmega',
      data: {
        schemaVersion: 2,
        '-startupProfileName': 'switch',
        '+Feed': {
          name: 'Feed',
          profileType: 'FixedProfile',
          fallbackProxy: { scheme: 'https', host: 'proxy.example', port: 443 },
          auth: { all: { username: 'user', password: 'secret' } }
        },
        '+switch': {
          profileType: 'SwitchProfile',
          defaultProfileName: 'direct',
          rules: [
            {
              condition: { conditionType: 'HostWildcardCondition', pattern: '*.feed.example' },
              profileName: 'Feed'
            }
          ]
        }
      }
    }
  ]
  for (const { name, data } of feeds) {
    let body = typeof data === 'string' ? data : JSON.stringify(data)
    const h = harness('firefox', {}, async (_, options) => {
      assert.equal(options.headers.Authorization, undefined)
      assert.equal(options.headers['X-MegaProxy-Client'], 'browser_firefox')
      return new Response(body)
    })
    assert.equal(
      (
        await h.send({
          command: 'import',
          data,
          subscription: { url: 'https://config.example/feed', enabled: true }
        })
      ).ok,
      true,
      name
    )
    await h.send({ command: 'theme', theme: 'light' })
    await h.send({ command: 'language', language: 'ru' })
    const initial = (await h.send({ command: 'get' })).state
    const id = initial.profiles[0].id
    await h.send({ command: 'activate', id })
    await h.send({ command: 'save', profile: { id: 'manual', host: 'manual.example', port: 443 } })
    await h.send({ command: 'routing', routing: { enabled: true, domains: ['old.example'] } })
    for (let attempt = 0; attempt < 2; attempt++) {
      await h.send({ command: 'updateConfigSubscription' })
      const state = (await h.send({ command: 'get' })).state
      assert.equal(state.profiles.length, 2, name)
      assert.equal(state.profiles[0].id, id, name)
      assert.equal(state.activeId, id, name)
      assert.equal(state.theme, name === 'LegacyMegaProxy' ? 'system' : 'light', name)
      assert.equal(state.language, name === 'LegacyMegaProxy' ? 'auto' : 'ru', name)
      assert.equal(
        state.browserRouting.domains[0],
        name === 'ZeroOmega'
          ? '**.feed.example'
          : name === 'LegacyMegaProxy'
            ? undefined
            : 'old.example',
        name
      )
      assert.equal(state.configSubscriptionState.error, undefined, name)
      if (name === 'FoxyProxy') {
        assert.equal(state.configSubscriptionState.skipped.length, 1)
      }
    }
    body = JSON.stringify({
      schema: 'net.megaproxy487.config',
      version: 8,
      profiles: [{ id, proxy: { type: 'HTTPS', host: 'replacement.example', port: 443 } }]
    })
    await h.send({ command: 'updateConfigSubscription' })
    const state = (await h.send({ command: 'get' })).state
    assert.equal(state.profiles[0].host, 'replacement.example')
    assert.equal(state.theme, 'system')
    assert.equal(state.language, 'auto')
    assert.equal(state.browserRouting.enabled, false)
    assert.equal(state.profiles.length, 2)
    assert.equal(state.activeId, id)
  }
})

test('subscription failover tries sources in order, imports legacy feeds and retries the primary next time', async () => {
  const urls = [
    'https://primary.example/feed',
    'https://backup.example/feed',
    'https://last.example/feed'
  ]
  const requests = []
  let mode = 'backup'
  const feed = 'https://proxy-user:proxy-secret@backup-proxy.example:443?title=Feed'
  const h = harness('firefox', {}, async (url, options) => {
    requests.push(url)
    assert.equal(options.redirect, 'error')
    assert.equal(
      options.headers.Authorization,
      `Basic ${Buffer.from('reader:feed-secret').toString('base64')}`
    )
    if (mode === 'offline') {
      throw new TypeError('Failed to fetch')
    }
    if (mode === 'primary' || url === urls[2]) {
      return new Response(feed)
    }
    return url === urls[0]
      ? new Response('Unauthorized', { status: 401 })
      : new Response('Invalid configuration')
  })
  const config = {
    schema: 'net.megaproxy487.config',
    version: 8,
    subscription: {
      url: urls[0],
      fallbackUrls: urls.slice(1),
      username: 'reader',
      password: 'feed-secret'
    },
    profiles: [
      { id: 'one', name: 'Feed', proxy: { type: 'HTTPS', host: 'proxy.example', port: 443 } }
    ]
  }
  assert.equal((await h.send({ command: 'import', data: config })).ok, true)
  await h.send({ command: 'activate', id: 'one' })
  await h.send({ command: 'updateConfigSubscription' })
  let state = (await h.send({ command: 'get' })).state
  assert.deepEqual(requests, urls)
  assert.equal(state.activeId, 'one')
  assert.equal(state.profiles[0].host, 'backup-proxy.example')
  assert.equal(state.profiles[0].password, 'proxy-secret')
  assert.equal(state.subscription.password, 'feed-secret')
  assert.equal(state.configSubscriptionState.sourceIndex, 2)
  assert.equal(state.configSubscriptionState.error, undefined)
  const snapshot = JSON.stringify(state.profiles)
  mode = 'offline'
  requests.length = 0
  await h.send({ command: 'updateConfigSubscription' })
  state = (await h.send({ command: 'get' })).state
  assert.deepEqual(requests, urls)
  assert.equal(JSON.stringify(state.profiles), snapshot)
  assert.equal(state.configSubscriptionState.error, 'errorConfigDownload')
  mode = 'primary'
  requests.length = 0
  await h.send({ command: 'updateConfigSubscription' })
  state = (await h.send({ command: 'get' })).state
  assert.deepEqual(requests, [urls[0]])
  assert.equal(state.configSubscriptionState.sourceIndex, 0)
  assert.equal(state.configSubscriptionState.error, undefined)
})

test('subscription updates select a replacement, reapply active parameters and notify only effective changes', async () => {
  for (const target of ['chromium', 'firefox']) {
    let remote
    const notifications = []
    const h = harness(target, {}, async () => new Response(JSON.stringify(remote)), {
      notifications: {
        create: async (...args) => notifications.push(args),
        clear: async () => {}
      },
      state: {
        activeId: 'removed',
        profiles: ['removed', 'local'].map(id => ({ id, host: `${id}.example`, port: 443 })),
        subscription: { url: 'https://config.example/', enabled: false },
        configSubscriptionState: { profileIds: ['removed'] }
      }
    })
    await h.flush()
    const snapshot = (ids, preferred) => ({
      schema: 'net.megaproxy487.config',
      version: 8,
      ...(preferred ? { activeProfileId: preferred } : {}),
      profiles: ids.map(id => ({ id, proxy: { type: 'HTTPS', host: `${id}.example`, port: 443 } }))
    })
    remote = snapshot(['first', 'preferred'], 'preferred')
    await h.send({ command: 'updateConfigSubscription' })
    let state = (await h.send({ command: 'get' })).state
    assert.equal(state.activeId, 'preferred')
    assert.equal(state.connectionMode, 'proxy')
    assert.equal(state.subscription.enabled, false)
    assert.equal(
      state.profiles.some(p => p.id === 'local'),
      true
    )
    assert.equal(notifications.length, 1)
    assert.match(state.connectionUpdate.message, target === 'chromium' ? /Chromium$/ : /Firefox$/)
    if (target === 'firefox') {
      const route = await h.events.proxy({ url: 'https://destination.example/', tabId: 1 })
      assert.equal(route[0].host, 'preferred.example')
    } else {
      assert.equal(
        h.calls.filter(c => c[0] === 'proxy').at(-1)[1].value.rules.singleProxy.host,
        'preferred.example'
      )
    }
    await h.send({ command: 'updateConfigSubscription' })
    assert.equal(notifications.length, 1)
    remote.profiles[0].proxy.host = 'inactive-change.example'
    remote.profiles[1].name = 'Metadata only'
    await h.send({ command: 'updateConfigSubscription' })
    assert.equal(notifications.length, 1)
    Object.assign(remote.profiles[1].proxy, {
      host: 'updated.example',
      username: 'reader',
      password: 'secret'
    })
    await h.send({ command: 'updateConfigSubscription' })
    state = (await h.send({ command: 'get' })).state
    assert.equal(state.profiles.find(p => p.id === state.activeId).host, 'updated.example')
    assert.equal(notifications.length, 2)
    assert.ok(!JSON.stringify(state.connectionUpdate).includes('secret'))
    assert.ok(!JSON.stringify(notifications).includes('secret'))
    const previous = state.connectionUpdate.updatedAt
    h.api.proxy.settings.set = async () => {
      throw new Error('native failure')
    }
    remote = snapshot(['replacement'])
    await h.send({ command: 'updateConfigSubscription' })
    state = (await h.send({ command: 'get' })).state
    assert.equal(state.activeId, 'preferred')
    assert.equal(state.connectionUpdate.updatedAt, previous)
    assert.ok(state.configSubscriptionState.error)
    assert.equal(notifications.length, 2)
    h.api.proxy.settings.set = async config => h.calls.push(['proxy', structuredClone(config)])
    await h.send({ command: 'updateConfigSubscription' })
    state = (await h.send({ command: 'get' })).state
    assert.equal(state.activeId, 'replacement')
    assert.equal(notifications.length, 3)
    h.api.notifications.create = async () => {
      throw new Error('notifications blocked')
    }
    remote.profiles[0].proxy.host = 'still-applied.example'
    await h.send({ command: 'updateConfigSubscription' })
    state = (await h.send({ command: 'get' })).state
    assert.equal(state.configSubscriptionState.error, undefined)
    assert.equal(state.profiles.find(p => p.id === state.activeId).host, 'still-applied.example')
    const restarted = harness(target, {}, undefined, { state: structuredClone(state) })
    await restarted.flush()
    assert.ok((await restarted.send({ command: 'get' })).state.connectionUpdate)
    restarted.events.startup()
    await restarted.flush()
    assert.equal((await restarted.send({ command: 'get' })).state.connectionUpdate, undefined)
    await h.send({ command: 'dismissConnectionUpdate' })
    assert.equal((await h.send({ command: 'get' })).state.connectionUpdate, undefined)
  }
})

test('Podkop changes notify after applying effective rules; identical lists and inactive routes stay quiet', async () => {
  for (const [target, strategy] of [
    ['chromium', 'lists'],
    ['firefox', 'lists'],
    ['firefox', undefined]
  ]) {
    let domains = 'new.example\n'
    const notifications = []
    const h = harness(
      target,
      {},
      async url => {
        if (url.includes('api.github.com')) {
          return new Response(
            JSON.stringify({
              truncated: false,
              tree: [{ type: 'blob', path: 'Services/youtube.lst' }]
            })
          )
        }
        return new Response(domains)
      },
      {
        notifications: { create: async (...args) => notifications.push(args) },
        state: {
          activeId: 'one',
          profiles: [{ id: 'one', host: 'proxy.example', port: 443 }],
          browserRouting: {
            enabled: true,
            strategy,
            mode: strategy ? 'domains' : 'tabs',
            subscriptions: {
              [strategy ? 'domainSources' : 'siteSources']: ['youtube'],
              autoUpdate: false
            }
          }
        }
      }
    )
    await h.flush()
    await h.send({ command: 'updateSubscriptions' })
    let state = (await h.send({ command: 'get' })).state
    assert.equal(notifications.length, 1)
    assert.ok(state.connectionUpdate)
    assert.equal(
      h.context.MegaProxy.routed('https://new.example/', state, 'https://new.example/'),
      true
    )
    await h.send({ command: 'updateSubscriptions' })
    assert.equal(notifications.length, 1)
    domains = 'changed.example\n'
    await h.send({ command: 'updateSubscriptions' })
    state = (await h.send({ command: 'get' })).state
    assert.equal(notifications.length, 2)
    assert.equal(
      h.context.MegaProxy.routed('https://new.example/', state, 'https://new.example/'),
      false
    )
    assert.equal(
      h.context.MegaProxy.routed('https://changed.example/', state, 'https://changed.example/'),
      true
    )
    await h.send({ command: 'connectionMode', mode: 'direct' })
    domains = 'offline.example\n'
    await h.send({ command: 'updateSubscriptions' })
    assert.equal(notifications.length, 2)
  }
})

test('replacing a selected subscription profile preserves Direct and System modes', async () => {
  for (const connectionMode of ['direct', 'system']) {
    const remote = {
      schema: 'net.megaproxy487.config',
      version: 8,
      activeProfileId: 'preferred',
      profiles: [
        { id: 'preferred', proxy: { type: 'HTTPS', host: 'preferred.example', port: 443 } }
      ]
    }
    const h = harness('firefox', {}, async () => new Response(JSON.stringify(remote)), {
      state: {
        connectionMode,
        activeId: 'removed',
        profiles: [{ id: 'removed', host: 'removed.example', port: 443 }],
        subscription: { url: 'https://config.example/', enabled: false },
        configSubscriptionState: { profileIds: ['removed'] }
      }
    })
    await h.send({ command: 'updateConfigSubscription' })
    const state = (await h.send({ command: 'get' })).state
    assert.equal(state.activeId, 'preferred')
    assert.equal(state.connectionMode, connectionMode)
    assert.equal(state.connectionUpdate, undefined)
  }
})

test('startup reads remote sync before refreshing a due subscription and preserves remote manual profiles', async () => {
  for (const target of ['chromium', 'firefox']) {
    const remotePayload = {
      config: {
        profiles: [
          { id: 'one', host: 'one.example', port: 443 },
          { id: 'remote-manual', host: 'remote.example', port: 443 }
        ]
      },
      preferences: { language: 'en', theme: 'light', bypassLocalNetworks: true, webRTC: 'browser' }
    }
    const shared = {
      megaConfig: { revision: 'remote', count: 1 },
      'mega:remote:0': JSON.stringify(remotePayload)
    }
    const h = harness(
      target,
      shared,
      async () =>
        new Response(
          JSON.stringify({
            schema: 'net.megaproxy487.config',
            version: 8,
            profiles: [{ id: 'one', proxy: { type: 'HTTPS', host: 'updated.example', port: 443 } }]
          })
        ),
      {
        state: {
          profiles: [{ id: 'one', host: 'one.example', port: 443 }],
          subscription: { url: 'https://config.example/', enabled: true },
          configSubscriptionState: { profileIds: ['one'], lastAttempt: 0 }
        }
      }
    )
    const operations = []
    const read = h.api.storage.sync.get
    const write = h.api.storage.sync.set
    h.api.storage.sync.get = async (...args) => {
      operations.push('read')
      return read(...args)
    }
    h.api.storage.sync.set = async (...args) => {
      operations.push('write')
      return write(...args)
    }
    await h.flush()
    const state = (await h.send({ command: 'get' })).state
    assert.equal(operations[0], 'read', target)
    assert.deepEqual(
      Array.from(state.profiles, p => p.id),
      ['one', 'remote-manual'],
      target
    )
    assert.equal(state.profiles[0].host, 'updated.example')
    const pointer = shared.megaConfig
    const published = JSON.parse(
      Array.from({ length: pointer.count }, (_, i) => shared[`mega:${pointer.revision}:${i}`]).join(
        ''
      )
    )
    assert.deepEqual(
      published.config.profiles.map(p => p.id),
      ['one', 'remote-manual']
    )
  }
})

test('legacy subscription matching reserves explicit IDs regardless of entry order', async () => {
  for (const reverse of [false, true]) {
    const one = {
      id: 'one',
      name: 'Shared name',
      proxy: { type: 'HTTPS', host: 'one.example', port: 443 }
    }
    const initial = { schema: 'net.megaproxy487.config', version: 6, profiles: [one] }
    const two = { name: 'Shared name', proxy: { type: 'HTTPS', host: 'two.example', port: 443 } }
    const remote = { ...initial, profiles: reverse ? [two, one] : [one, two] }
    const h = harness('firefox', {}, async () => new Response(JSON.stringify(remote)))
    await h.flush()
    await h.send({
      command: 'import',
      data: initial,
      subscription: { url: 'https://config.example/', enabled: false }
    })
    await h.send({ command: 'activate', id: 'one' })
    for (let update = 0; update < 2; update++) {
      assert.equal((await h.send({ command: 'updateConfigSubscription' })).ok, true)
      const state = (await h.send({ command: 'get' })).state
      assert.deepEqual(
        Array.from(state.profiles, p => p.host),
        ['one.example', 'two.example']
      )
      assert.equal(state.activeId, 'one')
      assert.equal(new Set(state.configSubscriptionState.profileIds).size, 2)
    }
  }
})

test('post-commit failures warn without replacing a successful subscription source or rejecting a save', async () => {
  for (const target of ['chromium', 'firefox']) {
    for (const failure of ['menus', 'badges', 'session', 'alarms']) {
      const requested = []
      const h = harness(target, {}, async url => {
        requested.push(url)
        return new Response(
          JSON.stringify({
            schema: 'net.megaproxy487.config',
            version: 8,
            profiles: [{ id: 'one', proxy: { type: 'HTTPS', host: 'primary.example', port: 443 } }]
          })
        )
      })
      await h.flush()
      await h.send({
        command: 'import',
        data: {
          schema: 'net.megaproxy487.config',
          version: 8,
          subscription: {
            url: 'https://primary.example/',
            fallbackUrls: ['https://backup.example/'],
            enabled: false
          },
          profiles: [{ id: 'one', proxy: { type: 'HTTPS', host: 'old.example', port: 443 } }]
        }
      })
      await h.send({ command: 'activate', id: 'one' })
      const fail = async () => {
        throw new Error('errorUnexpected')
      }
      if (failure === 'menus') {
        h.api.contextMenus.removeAll = fail
      }
      if (failure === 'badges') {
        vm.runInContext(
          'refreshBadges = async () => { throw new Error("errorUnexpected") }',
          h.context
        )
      }
      if (failure === 'session') {
        h.api.storage.session.set = fail
      }
      if (failure === 'alarms') {
        h.api.alarms = { clear: fail }
      }
      const updated = await h.send({ command: 'updateConfigSubscription' })
      assert.equal(updated.ok, true, `${target}: ${failure}`)
      assert.equal(updated.warning, 'errorUnexpected', `${target}: ${failure}`)
      assert.deepEqual(requested, ['https://primary.example/'])
      const state = (await h.send({ command: 'get' })).state
      assert.equal(state.profiles[0].host, 'primary.example')
      assert.equal(state.configSubscriptionState.sourceIndex, 0)
      assert.equal(state.configSubscriptionState.error, undefined)
      assert.equal((await h.send({ command: 'get' })).warning, 'errorUnexpected')
      h.api.contextMenus.removeAll = fail
      const saved = await h.send({
        command: 'save',
        profile: { id: 'local', host: 'local.example', port: 443 }
      })
      assert.equal(saved.ok, true)
      assert.equal(saved.warning, 'errorUnexpected')
      assert.equal(
        h.stored().state.profiles.some(p => p.id === 'local'),
        true
      )
    }
  }
})
