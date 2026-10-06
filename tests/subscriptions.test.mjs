import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import { gzipSync } from 'node:zlib'
import '../extension/platform.js'
import '../extension/core.js'
import '../extension/subscription-catalog.js'
import '../extension/subscriptions.js'

const M = globalThis.MegaProxy
const S = globalThis.MegaSubscriptions
const fake = files => async url => {
  if (!(url in files)) {
    throw new Error('offline')
  }
  return new Response(files[url])
}
const mirror = 'https://raw.githubusercontent.com/wangmm001/tranco-top1m-cache/main/data/'

test('domain lists generalize safely, remove covered subdomains and ignore IP, CIDR and non-domain entries', () => {
  const list = S.parseDomains(
    '# comment\nExample.com\na.example.com\nexample.com\nother.example.org\n1.2.3.4\n1.2.3.0/24\n*.broken.com\nhttps://broken.example\nпример.рф\n'
  )
  assert.deepEqual(list.domains, ['example.com', 'other.example.org', 'xn--e1afmkfd.xn--p1ai'])
  assert.equal(list.ignored, 4)
  assert.equal(M.matchesDomain('example.com', ['**.example.com']), true)
  assert.equal(M.matchesDomain('deep.a.example.com', ['**.example.com']), true)
  assert.equal(M.matchesDomain('notexample.com', ['**.example.com']), false)
  assert.equal(M.matchesDomain('example.org', ['**.example.com']), false)
  assert.throws(() => S.parseDomains('127.0.0.1\n10.0.0.0/8'), /errorListEmpty/)
  assert.throws(() => S.options({ domainSources: ['../missing'] }), /errorProfileFields/)
  assert.throws(() => S.options({ throughProxy: 'true' }), /errorProfileFields/)
})

test('popularity truncation keeps manual rules, uses nearest known parent rank and breaks unknown-rank ties deterministically', () => {
  const domains = ['z.example', 'popular.example', 'a.example', 'cdn.parent.example']
  const ranks = S.parseRanks(
    '1,parent.example\n2,popular.example\n3,unrelated.example\n4,localhost\n5,127.0.0.1\n',
    domains
  )
  const selected = S.select(domains, ['manual.example'], ranks, 3)
  assert.deepEqual(selected.patterns, ['**.cdn.parent.example', '**.popular.example'])
  assert.equal(selected.dropped, 2)
  assert.equal(selected.unranked, 2)
  assert.deepEqual(S.select(domains, [], {}, 2).patterns, ['**.a.example', '**.cdn.parent.example'])
  assert.deepEqual(S.select(domains, ['*'], {}, 3).patterns, [])
  assert.throws(() => S.parseRanks('<html>error</html>', domains), /errorRankingFormat/)
})

test('subscriptions download separate mode lists, bound sizes and only fetch popularity when the limit is exceeded', async () => {
  const urls = []
  const config = M.routing({
    domains: ['manual.example'],
    subscriptions: { domainSources: ['youtube'], siteSources: ['discord'] }
  })
  const files = Object.fromEntries(
    S.catalog()
      .filter(source => ['youtube', 'discord'].includes(source.id))
      .map(source => [source.url, 'a.example.com\nexample.com\n'])
  )
  const cache = await S.update(config, {}, async (url, options) => {
    urls.push(url)
    assert.equal(options.credentials, 'omit')
    return fake(files)(url)
  })
  assert.deepEqual(cache.domains, ['**.example.com'])
  assert.deepEqual(cache.sites, ['**.example.com'])
  assert.equal(cache.counts.domains.dropped, 0)
  assert.equal(urls.length, 2)
  assert.throws(() => M.routing({ subscriptions: { siteSources: ['../missing'] } }))
  await assert.rejects(
    S.download('https://example.com/', 3, fake({ 'https://example.com/': '1234' })),
    /errorListSize/
  )
  await assert.rejects(S.update(config, {}, fake({})))
})

test('oversized lists use the GitHub gzip ranking, official fallback and explicit cached/unknown ranking warnings', async () => {
  const source = S.catalog().find(source => source.id === 'youtube').url
  const config = M.routing({ subscriptions: { domainSources: ['youtube'] } })
  const domains = Array.from(
    { length: 1002 },
    (_, index) => `site${String(index).padStart(4, '0')}.example`
  )
  const files = {
    [source]: domains.join('\n'),
    [mirror + 'current.version.txt']: 'ABCDE',
    [mirror + 'current.csv.gz']: gzipSync('1,site1001.example\n2,site1000.example\n')
  }
  const cache = await S.update(config, {}, fake(files))
  assert.equal(cache.domains.length, 1000)
  assert.deepEqual(cache.domains.slice(0, 2), ['**.site1001.example', '**.site1000.example'])
  assert.equal(cache.counts.domains.dropped, 2)
  assert.equal(cache.rankingId, 'ABCDE')
  assert.equal(cache.rankingError, null)
  const cached = await S.update(config, cache, fake({ [source]: domains.join('\n') }))
  assert.equal(cached.rankingError, 'errorRankingUnavailable')
  assert.deepEqual(cached.domains, cache.domains)
  const official = await S.update(
    config,
    {},
    fake({
      [source]: domains.join('\n'),
      'https://tranco-list.eu/top-1m-id': '12345',
      'https://tranco-list.eu/download/12345/1000000': '1,site1001.example\n'
    })
  )
  assert.equal(official.rankingId, '12345')
  assert.equal(official.domains[0], '**.site1001.example')
})

const scripts = await Promise.all(
  ['platform.js', 'core.js', 'subscription-catalog.js', 'subscriptions.js', 'background.js'].map(
    file => readFile(`extension/${file}`, 'utf8')
  )
)
function harness(target, initial, fetcher) {
  const callbacks = {}
  const event = name => ({
    addListener: fn => {
      callbacks[name] = fn
    }
  })
  const proxy = []
  const alarms = []
  let stored = initial
  const api = {
    runtime: {
      id: 'test',
      getURL: () => 'moz-extension://test/',
      onMessage: event('message'),
      onStartup: event('startup')
    },
    extension: { isAllowedIncognitoAccess: async () => true },
    storage: {
      local: {
        get: async () => ({ state: stored }),
        set: async ({ state }) => {
          stored = state
        }
      }
    },
    proxy: {
      settings: {
        get: async () => ({}),
        set: async value => proxy.push(value),
        clear: async () => {}
      },
      onRequest: event('proxy')
    },
    tabs: {},
    alarms: {
      create: async (...args) => alarms.push(args),
      clear: async () => {},
      onAlarm: event('alarm')
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
    TextDecoder,
    btoa,
    structuredClone,
    AbortSignal,
    DecompressionStream,
    fetch: fetcher
  })
  scripts.forEach(script => vm.runInContext(script, context))
  const send = message =>
    new Promise(resolve => callbacks.message(message, { id: 'test' }, resolve))
  return { callbacks, proxy, alarms, send, flush: () => vm.runInContext('queue', context) }
}

test('proxy updates override selective routing, direct updates override matching domain rules, failures retain the last successful snapshot', async () => {
  const p = M.profile({
    id: 'proxy',
    host: 'proxy.example',
    port: 443,
    username: 'u',
    password: 'p'
  })
  for (const target of ['firefox', 'chromium']) {
    for (const throughProxy of [true, false]) {
      const initial = {
        ...M.defaults(),
        statisticsEnabled: false,
        activeId: p.id,
        profiles: [p],
        browserRouting: M.routing({
          enabled: true,
          domains: throughProxy
            ? []
            : ['other.example', 'api.github.com', 'raw.githubusercontent.com', 'tranco-list.eu'],
          mode: target === 'firefox' && throughProxy ? 'tabs' : 'domains',
          subscriptions: {
            domainSources: ['youtube'],
            siteSources: target === 'firefox' ? ['youtube'] : [],
            throughProxy,
            autoUpdate: false
          }
        })
      }
      let failure = false
      const h = harness(target, initial, async url => {
        if (target === 'firefox') {
          const info = await h.callbacks.proxy({ url, tabId: -1, type: 'xmlhttprequest' })
          assert.equal(throughProxy ? info[0].host : info.type, throughProxy ? p.host : 'direct')
          if (!throughProxy) {
            const otherTab = await h.callbacks.proxy({ url, tabId: 7, type: 'script' })
            assert.equal(otherTab[0].host, p.host)
          }
        } else {
          const pac = h.proxy.at(-1).value.pacScript.data
          const context = vm.createContext({})
          vm.runInContext(pac, context)
          assert.equal(
            context.FindProxyForURL(url, new URL(url).hostname),
            throughProxy ? 'HTTPS proxy.example:443' : 'DIRECT'
          )
          if (!throughProxy) {
            assert.equal(
              context.FindProxyForURL('https://other.example/', 'other.example'),
              'HTTPS proxy.example:443'
            )
          }
        }
        if (failure) {
          throw new Error('offline')
        }
        return new Response('example.com\ncdn.example.com\n')
      })
      const first = await h.send({ command: 'updateSubscriptions' })
      assert.equal(first.ok, true)
      assert.deepEqual(
        Array.from(
          first.state.subscriptionCache[target === 'firefox' && throughProxy ? 'sites' : 'domains']
        ),
        ['**.example.com']
      )
      failure = true
      assert.equal((await h.send({ command: 'updateSubscriptions' })).ok, false)
      const retained = (await h.send({ command: 'get' })).state.subscriptionCache
      assert.equal(retained.updatedAt, first.state.subscriptionCache.updatedAt)
      assert.deepEqual(
        Array.from(retained[target === 'firefox' && throughProxy ? 'sites' : 'domains']),
        ['**.example.com']
      )
      assert.equal(retained.error, 'errorListDownload')
      assert.equal((await h.send({ command: 'get' })).connectionCheck, null)
      assert.equal((await h.send({ command: 'get' })).statistics, undefined)
    }
  }
})

test('daily refresh scheduling works without statistics and proxy downloads require an active profile', async () => {
  const initial = {
    ...M.defaults(),
    statisticsEnabled: false,
    browserRouting: M.routing({ subscriptions: { domainSources: ['youtube'], throughProxy: true } })
  }
  const h = harness('firefox', initial, async () => assert.fail('No direct fallback'))
  assert.equal((await h.send({ command: 'updateSubscriptions' })).error, 'errorListProxyInactive')
  h.callbacks.startup()
  await h.flush()
  assert.equal(h.alarms.length, 0)
  h.callbacks.alarm({ name: 'subscriptions' })
  await h.flush()
  assert.equal((await h.send({ command: 'get' })).statistics, undefined)
})

test('effective subscription rules are cached and trimming remains visible after manual additions', () => {
  const config = M.routing({ enabled: true, subscriptions: { domainSources: ['youtube'] } })
  const state = {
    ...M.defaults(),
    statisticsEnabled: false,
    browserRouting: config,
    subscriptionCache: {
      sourceKey: S.sourceKey(config.subscriptions),
      domains: Array.from({ length: 1000 }, (_, i) => `**.site${i}.example`),
      sites: [],
      counts: { domains: { total: 1000, dropped: 0, unranked: 0 } }
    }
  }
  const first = M.routingPatterns(state, 'domains')
  assert.equal(M.routingPatterns(state, 'domains'), first)
  assert.equal(S.counts(state, 'domains').dropped, 0)
  state.browserRouting = M.routing({ ...config, domains: ['manual.example'] })
  assert.notEqual(M.routingPatterns(state, 'domains'), first)
  assert.equal(M.routingPatterns(state, 'domains').length, 1000)
  assert.equal(S.counts(state, 'domains').dropped, 1)
})

test('GitHub catalog discovers domain-only lists, preserves stable IDs and rejects unsafe or ambiguous trees', () => {
  const tree = paths =>
    JSON.stringify({ truncated: false, tree: paths.map(path => ({ type: 'blob', path })) })
  const parsed = S.parseCatalog(
    tree([
      'Services/google_meet.lst',
      'Russia/inside-raw.lst',
      'Categories/new-service.lst',
      'Subnets/IPv4/meta.lst',
      'Russia/inside-clashx.lst',
      '../Services/evil.lst'
    ])
  )
  assert.deepEqual(
    parsed.sources.map(source => source.id),
    ['google_meet', 'new-service', 'russia_inside']
  )
  assert.equal(
    parsed.sources[0].url,
    'https://raw.githubusercontent.com/itdoginfo/allow-domains/main/Services/google_meet.lst'
  )
  assert.throws(() => S.parseCatalog('{'), /errorListCatalog/)
  assert.throws(
    () => S.parseCatalog(JSON.stringify({ truncated: true, tree: [] })),
    /errorListCatalog/
  )
  assert.throws(
    () => S.parseCatalog(tree(['Services/same.lst', 'Categories/same.lst'])),
    /errorListCatalog/
  )
  assert.deepEqual(S.options({ domainSources: ['future_service', 'google_meet'] }).domainSources, [
    'future_service',
    'google_meet'
  ])
  assert.throws(
    () => S.options({ domainSources: ['https://evil.example/list'] }),
    /errorProfileFields/
  )
})

test('catalog refresh respects its TTL and retains validated cache or bundled fallback when GitHub is unavailable', async () => {
  const body = JSON.stringify({
    truncated: false,
    tree: [{ type: 'blob', path: 'Services/new_service.lst' }]
  })
  let calls = 0
  const fetcher = async url => {
    calls++
    return fake({ [S.catalogURL]: body })(url)
  }
  const current = await S.refreshCatalog(undefined, fetcher)
  assert.equal(current.sources[0].id, 'new_service')
  assert.equal((await S.refreshCatalog(current, fetcher)).updatedAt, current.updatedAt)
  assert.equal(calls, 1)
  const offline = await S.refreshCatalog(current, fake({}), true)
  assert.equal(offline.error, 'errorListCatalog')
  assert.deepEqual(offline.sources, current.sources)
  assert.equal(offline.updatedAt, current.updatedAt)
  const fallback = await S.refreshCatalog(undefined, fake({}))
  assert.equal(fallback.error, 'errorListCatalog')
  assert.ok(fallback.sources.some(source => source.id === 'google_meet'))
  const corrupt = { sources: [{ id: 'evil', path: '../evil', url: 'https://evil.example/' }] }
  assert.deepEqual(S.catalog(corrupt), S.catalog())
})

test('coverage is mode-specific, accounts for subdomains and is computed before popularity truncation', async () => {
  const sources = S.catalog()
  const urls = Object.fromEntries(sources.map(source => [source.id, source.url]))
  const config = M.routing({
    subscriptions: {
      domainSources: ['russia_inside', 'youtube', 'google_meet'],
      siteSources: ['youtube', 'discord']
    }
  })
  const large = Array.from({ length: 1001 }, (_, i) => `site${i}.example`).join('\n')
  const cache = await S.update(
    config,
    {},
    fake({
      [urls.russia_inside]: `example.com\n${large}`,
      [urls.youtube]: 'cdn.example.com\n',
      [urls.google_meet]: 'other.example.org\n',
      [urls.discord]: 'cdn.example.com\n'
    })
  )
  assert.deepEqual(cache.coverage.domains, [{ sourceId: 'youtube', coveredBy: 'russia_inside' }])
  assert.deepEqual(cache.coverage.sites, [{ sourceId: 'youtube', coveredBy: 'discord' }])
  assert.equal(cache.domains.length, 1000)
  assert.ok(cache.counts.domains.dropped > 0)
  await assert.rejects(
    S.update(M.routing({ subscriptions: { domainSources: ['unknown_service'] } }), {}, fake({})),
    /errorListUnknownSource/
  )
})

test('catalog-only background updates use the requested route and cache failures without losing the catalog', async () => {
  for (const target of ['chromium', 'firefox']) {
    let calls = 0
    const initial = {
      ...M.defaults(),
      browserRouting: M.routing({ subscriptions: { autoUpdate: false } })
    }
    const h = harness(target, initial, async url => {
      assert.equal(url, S.catalogURL)
      calls++
      if (calls > 1) {
        throw new Error('offline')
      }
      if (target === 'firefox') {
        assert.equal(
          (await h.callbacks.proxy({ url, tabId: -1, type: 'xmlhttprequest' })).type,
          'direct'
        )
      }
      return new Response(
        JSON.stringify({
          truncated: false,
          tree: [{ type: 'blob', path: 'Services/fresh_service.lst' }]
        })
      )
    })
    const first = await h.send({ command: 'updateSubscriptions' })
    assert.equal(first.ok, true)
    assert.equal(first.state.subscriptionCatalog.sources[0].id, 'fresh_service')
    const second = await h.send({ command: 'updateSubscriptions' })
    assert.equal(second.state.subscriptionCatalog.error, 'errorListCatalog')
    assert.equal(second.state.subscriptionCatalog.sources[0].id, 'fresh_service')
  }
})

test('inactive modes make no automatic downloads; opening routing refreshes only necessary data', async () => {
  for (const target of ['chromium', 'firefox']) {
    for (const mode of ['direct', 'system', 'manual', 'tabs', 'all', 'lists']) {
      const p = M.profile({ id: 'one', host: 'proxy.example', port: 443 })
      const fetched = []
      const initial = {
        ...M.defaults(),
        profiles: [p],
        activeId: p.id,
        connectionMode: ['direct', 'system'].includes(mode) ? mode : 'proxy',
        browserRouting: M.routing({
          enabled: mode !== 'all',
          strategy: mode === 'lists' ? 'lists' : mode === 'tabs' ? 'tabs' : 'manual',
          subscriptions: {
            domainSources: ['youtube'],
            siteSources: ['discord'],
            autoUpdate: mode !== 'lists'
          }
        })
      }
      const h = harness(target, initial, async url => {
        fetched.push(url)
        return new Response(
          url === S.catalogURL
            ? JSON.stringify({
                truncated: false,
                tree: [
                  { type: 'blob', path: 'Services/youtube.lst' },
                  { type: 'blob', path: 'Services/discord.lst' }
                ]
              })
            : 'example.com'
        )
      })
      h.callbacks.startup()
      await h.flush()
      h.callbacks.alarm({ name: 'subscriptions' })
      await h.flush()
      assert.equal(fetched.length, 0)
      assert.equal((await h.send({ command: 'routingOpened' })).ok, true)
      assert.equal(fetched.filter(url => url === S.catalogURL).length, 1)
      assert.equal(
        fetched.some(url => url.endsWith('/discord.lst')),
        false
      )
      assert.equal(
        fetched.some(url => url.endsWith('/youtube.lst')),
        mode === 'lists'
      )
      const count = fetched.length
      await h.send({ command: 'routingOpened' })
      assert.equal(fetched.length, count)
    }
  }
})

test('active automatic lists refresh once and stop requesting data after leaving the mode', async () => {
  const p = M.profile({ id: 'one', host: 'proxy.example', port: 443 })
  const initial = {
    ...M.defaults(),
    profiles: [p],
    activeId: p.id,
    browserRouting: M.routing({
      enabled: true,
      strategy: 'lists',
      subscriptions: { domainSources: ['youtube'], siteSources: ['discord'] }
    })
  }
  const urls = []
  const h = harness('firefox', initial, async url => {
    urls.push(url)
    return new Response(
      url === S.catalogURL
        ? JSON.stringify({
            truncated: false,
            tree: [
              { type: 'blob', path: 'Services/youtube.lst' },
              { type: 'blob', path: 'Services/discord.lst' }
            ]
          })
        : 'example.com'
    )
  })
  h.callbacks.startup()
  await h.flush()
  assert.equal(urls.length, 2)
  assert.equal(h.alarms[0][0], 'subscriptions')
  h.callbacks.alarm({ name: 'subscriptions' })
  await h.flush()
  await h.send({ command: 'routingOpened' })
  assert.equal(urls.length, 2)
  await h.send({ command: 'connectionMode', mode: 'direct' })
  await h.flush()
  h.callbacks.alarm({ name: 'subscriptions' })
  await h.flush()
  assert.equal(urls.length, 2)
})

test('startup and alarms with no selected lists preserve System and make no downloads', async () => {
  for (const target of ['chromium', 'firefox']) {
    let calls = 0
    const h = harness(target, M.defaults(), async () => {
      calls++
      return new Response(
        JSON.stringify({
          truncated: false,
          tree: [{ type: 'blob', path: 'Services/new_service.lst' }]
        })
      )
    })
    h.callbacks.startup()
    await h.flush()
    assert.equal(calls, 0)
    assert.equal(h.proxy.length, 0)
    h.callbacks.alarm({ name: 'subscriptions' })
    await h.flush()
    assert.equal(calls, 0)
    await h.send({ command: 'routingOpened' })
    assert.equal(calls, 1)
    await h.send({ command: 'routingOpened' })
    assert.equal(calls, 1)
  }
})
