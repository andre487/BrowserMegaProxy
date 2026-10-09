import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import '../extension/errors.js'
import '../extension/platform.js'
import '../extension/core.js'
import '../extension/subscription-catalog.js'
import '../extension/subscriptions.js'

const M = globalThis.MegaProxy
const p = M.profile({
  id: 'one',
  host: 'proxy.example',
  port: 443,
  username: 'user',
  password: 'secret',
  bypass: ['internal.example']
})
const state = {
  ...M.defaults(),
  statisticsEnabled: false,
  profiles: [p],
  activeId: p.id,
  browserRouting: M.routing({
    enabled: true,
    mode: 'domains',
    domains: ['site.example.com', '*.example.org', 'example.*'],
    sites: ['site.example.com']
  })
}

test('Firefox IPv6 knock hosts bypass selective inclusion rules but still honor explicit exclusions', () => {
  for (const mode of ['domains', 'tabs']) {
    const profile = M.profile({
      id: 'ipv6',
      host: 'proxy.example',
      port: 443,
      knockHost: '[2001:db8::1]'
    })
    const config = {
      ...M.defaults(),
      profiles: [profile],
      activeId: profile.id,
      bypassLocalNetworks: false,
      browserRouting: M.routing({
        enabled: true,
        mode,
        strategy: mode === 'tabs' ? 'tabs' : 'manual',
        domains: ['other.example'],
        sites: ['other.example']
      })
    }
    assert.equal(M.routed('https://[2001:db8::1]/', config), true)
    assert.equal(M.proxyInfo('https://[2001:db8::1]/', config).host, 'proxy.example')
    assert.equal(M.routed('https://[2001:db8::2]/', config), false)
    assert.equal(
      M.routed('https://[2001:db8::1]/', {
        ...config,
        profiles: [{ ...profile, bypass: ['2001:db8::1'] }]
      }),
      false
    )
    assert.equal(
      M.routed('https://[2001:db8::1]/', {
        ...config,
        profiles: [{ ...profile, username: 'user', password: 'secret' }]
      }),
      false
    )
  }
})

test('wildcards match whole hostnames, normalize IDNA and validate untrusted patterns', () => {
  for (const [hostname, expected] of [
    ['site.example.com', true],
    ['notsite.example.com', false],
    ['cdn.example.org', true],
    ['example.org', true],
    ['example.net', true],
    ['cdn.example.net', false],
    ['SITE.EXAMPLE.COM.', true]
  ]) {
    assert.equal(M.routed(`https://${hostname}/`, state), expected, hostname)
  }
  assert.equal(M.matchesDomain('a'.repeat(250), ['*a'.repeat(100) + '*b']), false)
  assert.equal(M.matchesDomain('a', ['a*a']), false)
  assert.equal(M.matchesDomain('abab', ['*a*b']), true)
  assert.equal(M.matchesDomain('example.org', ['*.example.org']), false)
  assert.equal(M.domainPattern('пример.рф'), 'xn--e1afmkfd.xn--p1ai')
  for (const value of [
    'https://example.com',
    'example.com:443',
    '*.example.com/path',
    'foo..*.com',
    '*.-bad.com',
    null,
    1
  ]) {
    assert.throws(() => M.domainPattern(value))
  }
  assert.throws(() => M.routing({ enabled: 'true' }))
  assert.throws(() => M.routing({ mode: 'vpn' }))
  assert.throws(() => M.routing({ sites: 'example.com' }))
})

test('Firefox tab routing includes third-party resources and honors direct overrides and bypass', () => {
  const tabs = { ...state, browserRouting: { ...state.browserRouting, mode: 'tabs' } }
  assert.equal(M.routed('https://cdn.other.com/script.js', tabs, 'https://site.example.com/'), true)
  assert.equal(
    M.routed('https://cdn.other.com/script.js', tabs, 'https://other.example.com/'),
    false
  )
  assert.equal(M.routed('https://site.example.com/', tabs), false)
  assert.equal(M.routed('https://cdn.other.com/', tabs, 'https://other.example.com/', true), true)
  assert.equal(M.routed('https://cdn.other.com/', tabs, 'https://site.example.com/', false), false)
  assert.equal(M.routed('https://10.0.0.1/', tabs, 'https://site.example.com/', true), false)
  assert.equal(M.routed('https://internal.example/', tabs, 'https://site.example.com/'), false)
  assert.equal(
    M.proxyInfo('https://cdn.other.com/', tabs, 'https://site.example.com/')
      .proxyAuthorizationHeader,
    'Basic dXNlcjpzZWNyZXQ='
  )
})

test('Chromium PAC matches Firefox destination routing including local IPv6 and bypass priority', () => {
  for (const bypassLocalNetworks of [true, false]) {
    const config = { ...state, bypassLocalNetworks }
    const pac = M.chromiumConfig(p, config)
    assert.equal(pac.mode, 'pac_script')
    assert.equal(pac.pacScript.mandatory, true)
    const context = vm.createContext({})
    vm.runInContext(pac.pacScript.data, context)
    for (const hostname of [
      'site.example.com',
      'example.org',
      'cdn.example.org',
      'example.net',
      'notexample.net',
      '10.0.0.1',
      '[::1]',
      '[::ffff:192.168.1.1]',
      'internal.example',
      'sub.internal.example'
    ]) {
      assert.equal(
        context.FindProxyForURL(`https://${hostname}/`, hostname),
        M.routed(`https://${hostname}/`, config) ? 'HTTPS proxy.example:443' : 'DIRECT',
        hostname
      )
    }
    const all = { ...config, browserRouting: M.routing({ enabled: true, domains: ['*'] }) }
    vm.runInContext(M.chromiumConfig(p, all).pacScript.data, context)
    assert.equal(
      context.FindProxyForURL('https://[::1]/', '[::1]'),
      bypassLocalNetworks ? 'DIRECT' : 'HTTPS proxy.example:443'
    )
  }
})

test('routing round-trips and Chromium explicitly downgrades unsupported Firefox tab settings', () => {
  const config = M.exportConfig({
    ...state,
    browserRouting: { ...state.browserRouting, mode: 'tabs' }
  })
  assert.equal(config.browser.routing.mode, 'tabs')
  const firefox = M.importProfiles(config, 'firefox')
  assert.equal(firefox.unknownFields, false)
  assert.equal(firefox.unsupportedSplitProxy, false)
  assert.deepEqual(M.mergeImport(M.defaults(), firefox).browserRouting, config.browser.routing)
  const chromium = M.importProfiles(config, 'chromium')
  assert.equal(chromium.unsupportedSplitProxy, true)
  const merged = M.mergeImport(M.defaults(), chromium)
  assert.equal(merged.browserRouting.mode, 'domains')
  assert.deepEqual(merged.browserRouting.sites, [])
  assert.deepEqual(merged.browserRouting.domains, state.browserRouting.domains)
  assert.equal(M.exportConfig(merged).browser.routing.mode, 'domains')
  assert.deepEqual(M.exportConfig(merged).browser.routing.sites, [])
  assert.equal(
    M.mergeImport(
      state,
      M.importProfiles({ profiles: [{ type: 'https', host: p.host, port: 443 }] })
    ).browserRouting,
    state.browserRouting
  )
})

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
function harness(target) {
  const events = {}
  const event = name => ({
    addListener: fn => {
      events[name] = fn
    }
  })
  const tabs = new Map([
    [7, { id: 7, url: 'https://site.example.com/' }],
    [8, { id: 8, url: 'https://other.example.com/' }]
  ])
  const reloaded = []
  const api = {
    runtime: { id: 'test', getURL: () => 'moz-extension://test/', onMessage: event('message') },
    extension: { isAllowedIncognitoAccess: async () => true },
    storage: { local: { get: async () => ({ state }), set: async () => {} } },
    proxy: { settings: { get: async () => ({}), set: async () => {} }, onRequest: event('proxy') },
    tabs: {
      query: async () => [tabs.get(7)],
      get: async id => tabs.get(id),
      reload: async id => reloaded.push(id),
      onUpdated: event('updated'),
      onRemoved: event('removed')
    },
    webRequest: Object.fromEntries(
      ['onAuthRequired', 'onCompleted', 'onErrorOccurred'].map(name => [name, event(name)])
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
  scripts.forEach(script => vm.runInContext(script, context))
  const send = message => new Promise(resolve => events.message(message, { id: 'test' }, resolve))
  return { events, tabs, reloaded, send }
}

test('Firefox proxy listener uses top-level navigation, redirects, existing tabs and manual overrides', async () => {
  const h = harness('firefox')
  await h.send({ command: 'routing', routing: { ...state.browserRouting, mode: 'tabs' } })
  const request = (tabId, url, type = 'script') => h.events.proxy({ tabId, url, type })
  assert.equal((await request(7, 'https://cdn.other.com/'))[0].host, p.host)
  assert.equal((await request(8, 'https://cdn.other.com/')).type, 'direct')
  assert.equal((await request(-1, 'https://site.example.com/')).type, 'direct')
  assert.equal((await request(8, 'https://site.example.com/', 'main_frame'))[0].host, p.host)
  assert.equal((await request(8, 'https://redirect.other.com/', 'main_frame')).type, 'direct')
  assert.equal((await request(8, 'https://cdn.other.com/')).type, 'direct')
  assert.equal((await h.send({ command: 'toggleTab' })).currentSite.proxied, false)
  assert.equal((await request(7, 'https://cdn.other.com/')).type, 'direct')
  assert.deepEqual(h.reloaded, [7])
  h.events.removed(7)
  assert.equal((await request(7, 'https://cdn.other.com/'))[0].host, p.host)
  const result = await h.send({ command: 'addCurrentSite' })
  assert.equal(result.ok, true)
  assert.equal(result.state.browserRouting.enabled, true)
  assert.equal(
    result.state.browserRouting.sites.filter(host => host === 'site.example.com').length,
    1
  )
  await h.send({ command: 'toggleTab' })
  assert.equal((await request(7, 'https://cdn.other.com/')).type, 'direct')
  await h.send({ command: 'addCurrentSite' })
  assert.equal((await request(7, 'https://cdn.other.com/'))[0].host, p.host)
})

test('Chromium rejects tab controls and exposes the explicit import compatibility warning', async () => {
  const h = harness('chromium')
  assert.equal(M.chromiumImplicitHost('127.0.0.1'), true)
  assert.equal(M.chromiumImplicitHost('[fe80::1]'), true)
  assert.equal(M.chromiumImplicitHost('192.168.1.1'), false)
  const config = M.exportConfig({
    ...state,
    browserRouting: { ...state.browserRouting, mode: 'tabs' }
  })
  assert.equal(
    (await h.send({ command: 'previewImport', data: config })).unsupportedSplitProxy,
    true
  )
  const imported = await h.send({ command: 'import', data: config })
  assert.equal(imported.warning, 'splitUnsupportedWarning')
  assert.equal(imported.state.browserRouting.mode, 'domains')
  assert.equal((await h.send({ command: 'toggleTab' })).error, 'errorSplitUnsupported')
  assert.equal(
    (await h.send({ command: 'routing', routing: { mode: 'tabs' } })).error,
    'errorSplitUnsupported'
  )
})

test('exclusive strategies preserve inactive data and agree between Firefox decisions and Chromium PAC', () => {
  const secondary = M.profile({ id: 'two', host: 'second.example', port: 443 })
  const settings = globalThis.MegaSubscriptions.options({ domainSources: ['youtube'] })
  for (const strategy of ['manual', 'lists', 'tabs', 'failover']) {
    const routing = M.routing({
      enabled: true,
      strategy,
      domains: ['manual.example'],
      sites: ['tab.example'],
      assignments: [{ domain: 'assigned.example', profileId: 'two' }],
      subscriptions: settings
    })
    const current = {
      ...state,
      profiles: [p, secondary],
      browserRouting: routing,
      subscriptionCache: {
        sourceKey: globalThis.MegaSubscriptions.sourceKey(settings),
        domains: ['**.listed.example'],
        sites: ['**.inactive.example']
      }
    }
    const expected = {
      manual: 'manual.example',
      lists: 'listed.example',
      tabs: 'tab.example'
    }[strategy]
    for (const domain of [
      'manual.example',
      'listed.example',
      'assigned.example',
      'tab.example',
      'inactive.example',
      'other.example'
    ]) {
      const url = `https://${domain}/`
      assert.equal(
        M.routed(url, current, url),
        strategy === 'failover' || domain === expected,
        `${strategy}: ${domain}`
      )
    }
    assert.deepEqual(routing.domains, ['manual.example'])
    assert.deepEqual(routing.assignments, [])
    if (strategy !== 'tabs') {
      const config = M.chromiumConfig(p, current)
      if (strategy === 'failover') {
        assert.equal(config.mode, 'fixed_servers')
      } else {
        const context = vm.createContext({})
        vm.runInContext(config.pacScript.data, context)
        for (const domain of [
          'manual.example',
          'listed.example',
          'assigned.example',
          'other.example'
        ]) {
          const endpoint = context.FindProxyForURL(`https://${domain}/`, domain)
          assert.equal(
            endpoint,
            domain === expected
              ? `HTTPS ${strategy === 'profiles' ? secondary.host : p.host}:443`
              : 'DIRECT'
          )
        }
      }
    }
  }
  assert.throws(() => M.routing({ strategy: 'unknown' }), /errorProfileFields/)
})
