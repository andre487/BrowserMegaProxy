import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import Ajv from 'ajv/dist/2020.js'
import '../extension/errors.js'
import '../extension/platform.js'
import '../extension/core.js'
import '../extension/subscription-catalog.js'
import '../extension/subscriptions.js'

const M = globalThis.MegaProxy
const schema = JSON.parse(await readFile('config-schema/megaproxy-v8.schema.json'))
const baseline = JSON.parse(await readFile('config-schema/android-v8.schema.json'))
const ajv = new Ajv({ strict: true })
const validate = ajv.compile(schema)
const android = ajv.compile(baseline)
const portable = {
  schema: 'net.megaproxy487.config',
  version: 8,
  routing: { bypassLocalNetworks: true },
  profiles: [
    {
      id: 'server',
      name: 'Server',
      color: 5,
      countryCode: 'US',
      proxy: {
        type: 'HTTPS',
        host: 'proxy.example',
        port: 443,
        username: 'user',
        password: 'secret'
      },
      dns: { provider: 'QUAD9' },
      tls: { fingerprint: 'CHROME_ANDROID' },
      browser: { knockHost: 'knock.example' }
    }
  ]
}

test('vendored schemas match recorded checksums and identify their upstream revision', async () => {
  const lock = JSON.parse(await readFile('config-schema/schema-lock.json'))
  assert.match(lock.commit, /^[a-f0-9]{40}$/)
  assert.deepEqual(lock.files, lock.upstreamFiles)
  assert.deepEqual(lock.overrides, [])
  for (const [file, hash] of Object.entries(lock.files)) {
    assert.equal(
      createHash('sha256')
        .update(await readFile(`config-schema/${file}`))
        .digest('hex'),
      hash
    )
  }
})

test('SOCKS5 imports and exports preserve the protocol and report unsupported authentication', () => {
  const config = structuredClone(portable)
  config.profiles[0].proxy.type = 'SOCKS5'
  config.profiles[0].proxy.port = 1080
  assert.ok(validate(config), JSON.stringify(validate.errors))
  assert.equal(android(config), false)
  const result = M.importProfiles(config, 'firefox')
  const state = M.mergeImport(M.defaults(), result)
  assert.equal(state.profiles[0].type, 'socks5')
  const exported = M.exportConfig(state, true)
  assert.ok(validate(exported), JSON.stringify(validate.errors))
  assert.equal(exported.profiles[0].proxy.type, 'SOCKS5')
  assert.equal(exported.profiles[0].proxy.password, 'secret')
  assert.equal(M.exportConfig(state).profiles[0].proxy.password, undefined)
  assert.throws(() => M.importProfiles(config, 'chromium'), /errorSocksAuthUnsupported/)
  delete config.profiles[0].proxy.username
  delete config.profiles[0].proxy.password
  assert.equal(M.importProfiles(config, 'chromium').profiles[0].type, 'socks5')
  assert.equal(M.importProfiles('socks5://proxy.example', 'chromium').profiles[0].port, 1080)
  assert.equal(M.importProfiles('socks5://u:p@proxy.example', 'firefox').profiles[0].password, 'p')
  assert.equal(
    M.importProfiles({ data: [{ type: 'socks', host: 'proxy.example' }] }, 'firefox').profiles[0]
      .type,
    'socks5'
  )
  assert.throws(
    () => M.importProfiles('socks5://u:p@proxy.example', 'chromium'),
    /errorSocksAuthUnsupported/
  )
})

test('stable-ID merges retain order and omitted secrets, clear explicit secrets and remove only selected absent profiles', () => {
  const first = M.importProfiles(portable)
  let state = M.mergeImport(M.defaults(), first)
  state.profiles.push(M.profile({ id: 'local', name: 'Local', host: 'other.example', port: 443 }))
  state.activeId = 'server'
  const updated = structuredClone(portable)
  updated.profiles[0].name = 'Updated'
  delete updated.profiles[0].proxy.password
  state = M.mergeImport(state, M.importProfiles(updated))
  assert.deepEqual(
    state.profiles.map(p => p.id),
    ['server', 'local']
  )
  assert.equal(state.profiles[0].password, 'secret')
  assert.equal(state.activeId, 'server')
  updated.profiles[0].proxy.password = ''
  state = M.mergeImport(state, M.importProfiles(updated), ['local'])
  assert.equal(state.profiles[0].password, '')
  assert.equal(state.profiles.length, 1)
  assert.throws(() => M.mergeImport(state, first, ['server']))
  assert.throws(() =>
    M.importProfiles({ ...portable, profiles: [...portable.profiles, ...portable.profiles] })
  )
  assert.throws(
    () => M.importProfiles({ ...portable, activeProfileId: 'missing' }),
    /errorProfileMissing/
  )
})

test('export validates against both schemas and discards unsupported fields without leaking omitted secrets', () => {
  const state = M.mergeImport(M.defaults(), M.importProfiles(portable))
  state.profiles[0].name = 'Edited'
  const config = M.exportConfig(state)
  assert.ok(validate(config), JSON.stringify(validate.errors))
  assert.ok(android(config), JSON.stringify(android.errors))
  assert.equal(config.profiles[0].dns, undefined)
  assert.equal(M.importProfiles(portable).unknownFields, true)
  assert.equal(config.profiles[0].name, 'Edited')
  assert.equal(config.profiles[0].proxy.password, undefined)
  assert.equal(JSON.stringify(config).includes('secret'), false)
  assert.equal(M.exportConfig(state, true).profiles[0].proxy.password, 'secret')
  assert.equal(M.importProfiles(config).profiles[0].knockHost, 'knock.example')
  state.profiles[0].type = 'http'
  assert.throws(() => M.exportConfig(state), /errorExportProtocol/)
})

test('importing a profile without a username clears an omitted local password', () => {
  const state = M.mergeImport(M.defaults(), M.importProfiles(portable))
  const config = structuredClone(portable)
  config.profiles[0].proxy.username = ''
  delete config.profiles[0].proxy.password
  const merged = M.mergeImport(state, M.importProfiles(config))
  assert.equal(merged.profiles[0].password, '')
  assert.doesNotThrow(() => merged.profiles.map(p => M.profile(p)))
})

test('import rejects knock conflicts introduced by preserving omitted local bypass rules', () => {
  const state = M.mergeImport(M.defaults(), M.importProfiles(portable))
  state.profiles[0].bypass = ['internal.example']
  const config = structuredClone(portable)
  config.profiles[0].browser = { knockHost: 'internal.example' }
  assert.throws(() => M.mergeImport(state, M.importProfiles(config)), /errorKnockBypass/)
  assert.equal(state.profiles[0].knockHost, 'knock.example')
})

test('all Android input formats preserve encoded credentials, metadata and reject unsupported transports', () => {
  for (const prefix of ['', '# superproxy:proxylist:v1\n']) {
    const result = M.importProfiles(
      prefix +
        '# comment\nhttps://a%2Bb:p%3Aa%2Bss@proxy.example?title=My+proxy&cc=de\nssh://user:secret@ssh.example'
    )
    assert.equal(result.profiles[0].username, 'a+b')
    assert.equal(result.profiles[0].password, 'p:a+ss')
    assert.equal(result.profiles[0].name, 'My proxy')
    assert.equal(result.profiles[0].countryCode, 'DE')
    assert.equal(result.skipped.length, 1)
  }
  const foxy = M.importProfiles(
    JSON.stringify({
      data: [
        {
          type: 'ssl',
          address: 'proxy.example',
          port: '8443',
          title: 'Foxy',
          cc: 'GB',
          username: 'user',
          password: 'secret'
        }
      ]
    })
  )
  assert.equal(foxy.profiles[0].port, 8443)
  assert.equal(foxy.profiles[0].countryCode, 'GB')
  assert.throws(() => M.importProfiles('https://user@proxy.example'))
  const chain = structuredClone(portable)
  chain.profiles[0].proxy.type = 'HTTPS_JUMP'
  chain.profiles[0].proxy.jump = { host: 'jump.example', port: 443 }
  assert.throws(() => M.importProfiles(chain), /errorImportCompatible/)
})

test('imports without colors choose random distinct palette colors and preserve supplied colors', t => {
  const random = t.mock.method(Math, 'random', () => 0.999)
  const urls = Array.from(
    { length: M.colors.length + 1 },
    (_, index) => `https://user:secret@proxy${index}.example:443`
  ).join('\n')
  const imported = M.importProfiles(urls).profiles
  assert.equal(imported[0].color, M.colors.length - 1)
  assert.equal(new Set(imported.slice(0, M.colors.length).map(p => p.color)).size, M.colors.length)
  assert.ok(
    imported.every(p => Number.isInteger(p.color) && p.color >= 0 && p.color < M.colors.length)
  )
  random.mock.mockImplementation(() => 0)
  assert.equal(M.importProfiles(urls).profiles[0].color, 0)

  const entries = [
    { host: 'one.example', type: 'https', color: 0 },
    { host: 'two.example', type: 'https' },
    { host: 'three.example', type: 'https', color: M.colors[5] }
  ]
  for (const input of [entries, { profiles: entries }, { data: entries }]) {
    assert.deepEqual(
      M.importProfiles(input).profiles.map(p => p.color),
      [0, 1, 5]
    )
  }
  assert.equal(M.importProfiles(portable).profiles[0].color, 5)
  const withoutColor = structuredClone(portable)
  delete withoutColor.profiles[0].color
  assert.equal(M.importProfiles(withoutColor).profiles[0].color, 0)
})

test('local networks bypass by default and disabling it routes literals through the proxy', () => {
  const p = M.profile({ host: 'proxy.example', port: 443 })
  for (const host of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.0.1',
    '[::1]',
    '[fd00::1]',
    '[fe80::1]',
    '[::ffff:192.168.1.1]',
    'localhost',
    'printer.local'
  ]) {
    const state = { ...M.defaults(), profiles: [p], activeId: p.id }
    assert.equal(M.proxyInfo(`https://${host}`, state).type, 'direct', host)
    state.bypassLocalNetworks = false
    assert.equal(M.proxyInfo(`https://${host}`, state).type, 'https', host)
  }
  for (const host of ['172.15.1.1', '172.32.0.1', '1.1.1.1', '[2606:4700::1111]', 'example.com']) {
    assert.equal(M.localHost(M.host(host)), false, host)
  }
  assert.ok(M.chromiumConfig(p).rules.bypassList.includes('192.168.0.0/16'))
  assert.deepEqual(M.chromiumConfig(p, { bypassLocalNetworks: false }).rules.bypassList, [
    '<-loopback>'
  ])
})

test('standalone browser validator rejects invalid optional fields at import', async () => {
  await import('../scripts/build.mjs')
  const context = vm.createContext({ crypto, URL, TextEncoder, btoa, structuredClone })
  vm.runInContext(await readFile('dist/chromium/config-validator.js', 'utf8'), context)
  vm.runInContext(await readFile('extension/errors.js', 'utf8'), context)
  vm.runInContext(await readFile('extension/platform.js', 'utf8'), context)
  vm.runInContext(await readFile('extension/core.js', 'utf8'), context)
  vm.runInContext(await readFile('extension/subscription-catalog.js', 'utf8'), context)
  vm.runInContext(await readFile('extension/subscriptions.js', 'utf8'), context)
  const invalid = structuredClone(portable)
  invalid.profiles[0].browser.authMode = 'invalid'
  assert.throws(() => context.MegaProxy.importProfiles(invalid), /errorProfileFields/)
  const config = context.MegaProxy.exportConfig(
    M.mergeImport(M.defaults(), M.importProfiles(portable))
  )
  assert.ok(context.MegaValidate(config))
  const future = structuredClone(config)
  future.subscription = { url: 'https://configs.example/', futureSetting: { secret: 'hidden' } }
  future.profiles[0].routing = { bypassLocalNetworks: false }
  future.browser.routing = {
    strategy: 'failover',
    assignments: [{ domain: 'example.com', profileId: 'server' }]
  }
  for (const target of ['chromium', 'firefox']) {
    const imported = context.MegaProxy.importProfiles(future, target)
    assert.equal(imported.unknownFields, true)
    assert.equal(imported.config.subscription.futureSetting, undefined)
    assert.equal(imported.profiles[0].portable.routing, undefined)
    assert.equal(imported.config.browser.routing.strategy, 'manual')
    assert.equal(imported.config.browser.routing.enabled, false)
    assert.equal(imported.config.browser.routing.assignments.length, 0)
    const exported = context.MegaProxy.exportConfig(
      context.MegaProxy.mergeImport(context.MegaProxy.defaults(), imported)
    )
    assert.equal(exported.subscription.futureSetting, undefined)
    assert.equal(exported.profiles[0].routing, undefined)
    assert.ok(context.MegaValidate(exported))
  }
  future.subscription.intervalMinutes = '60'
  assert.throws(() => context.MegaProxy.importProfiles(future), /errorProfileFields/)
})

test('unknown and unsupported fields produce one flag and never survive import or export', () => {
  const config = structuredClone(portable)
  config.futureGlobal = { password: 'hidden' }
  config.profiles[0].futureProfile = 'future'
  config.profiles[0].browser.unknownBrowserOption = true
  const imported = M.importProfiles(config)
  assert.equal(imported.unknownFields, true)
  assert.equal(imported.config.futureGlobal, undefined)
  assert.equal(imported.profiles[0].portable.dns, undefined)
  assert.equal(imported.profiles[0].portable.futureProfile, undefined)
  assert.equal(imported.profiles[0].portable.browser.unknownBrowserOption, undefined)
  const exported = M.exportConfig(M.mergeImport(M.defaults(), imported))
  assert.equal(exported.futureGlobal, undefined)
  assert.equal(exported.profiles[0].futureProfile, undefined)
  assert.equal(exported.profiles[0].dns, undefined)
  assert.equal(M.importProfiles(exported).unknownFields, false)
  const partial = structuredClone(portable)
  partial.profiles[0].browser = { unknownBrowserOption: true }
  const existing = M.mergeImport(M.defaults(), M.importProfiles(portable))
  const merged = M.mergeImport(existing, M.importProfiles(partial))
  assert.equal(merged.profiles[0].knockHost, 'knock.example')
  assert.equal(M.importProfiles('https://user:secret@proxy.example?future=1').unknownFields, true)
  assert.equal(
    M.importProfiles({
      data: [{ type: 'https', hostname: 'proxy.example', port: 443, unknown: true }]
    }).unknownFields,
    true
  )
})

test('subscription preferences round-trip, preserve Android compatibility and discard unsupported Firefox source lists in Chromium', () => {
  const state = M.mergeImport(M.defaults(), M.importProfiles(portable))
  state.browserRouting = M.routing({
    enabled: true,
    mode: 'tabs',
    subscriptions: {
      domainSources: ['youtube'],
      siteSources: ['discord'],
      throughProxy: true,
      autoUpdate: false
    }
  })
  state.subscriptionCache = {
    domains: ['**.cached.example'],
    updatedAt: Date.now(),
    error: 'hidden'
  }
  const config = M.exportConfig(state)
  assert.ok(validate(config), JSON.stringify(validate.errors))
  assert.ok(android(config), JSON.stringify(android.errors))
  assert.equal(config.subscriptionCache, undefined)
  assert.equal(JSON.stringify(config).includes('cached.example'), false)
  const chromium = M.mergeImport(M.defaults(), M.importProfiles(config, 'chromium'))
  assert.deepEqual(chromium.browserRouting.subscriptions.siteSources, [])
  assert.deepEqual(chromium.browserRouting.subscriptions.domainSources, ['youtube'])
  assert.equal(chromium.browserRouting.subscriptions.throughProxy, true)
  assert.equal(chromium.browserRouting.subscriptions.autoUpdate, false)
})

test('WebRTC round-trips while obsolete assignments are ignored with a warning', () => {
  const config = structuredClone(portable)
  config.browser = {
    webRTC: 'disabled',
    routing: {
      enabled: true,
      mode: 'tabs',
      sites: ['example.com'],
      assignments: [{ domain: 'example.com', profileId: 'server' }]
    }
  }
  assert.ok(validate(config), JSON.stringify(validate.errors))
  assert.ok(android(config), JSON.stringify(android.errors))
  const imported = M.importProfiles(config, 'firefox')
  const exported = M.exportConfig(M.mergeImport(M.defaults(), imported), true)
  assert.equal(exported.browser.webRTC, 'disabled')
  assert.deepEqual(exported.browser.routing.assignments, [])
  assert.equal(imported.unknownFields, true)
  const chromium = M.importProfiles(config, 'chromium')
  assert.equal(chromium.unsupportedSplitProxy, true)
  assert.equal(chromium.unsupportedWebRTC, true)
  assert.equal(chromium.browserRouting.assignments.length, 0)
  assert.equal(chromium.config.browser.webRTC, 'browser')
  config.browser.routing.assignments[0].profileId = 'missing'
  assert.deepEqual(M.importProfiles(config, 'firefox').browserRouting.assignments, [])
  config.browser.routing.assignments[0].domain = '*.example.com'
  assert.equal(validate(config), false)
})

test('dynamic subscription IDs validate, round-trip and reject unsafe identifiers', () => {
  const config = structuredClone(portable)
  config.browser = {
    routing: { subscriptions: { domainSources: ['google_meet', 'future_service'] } }
  }
  assert.ok(validate(config), JSON.stringify(validate.errors))
  const imported = M.importProfiles(config)
  const exported = M.exportConfig({ ...M.defaults(), ...imported }, true)
  assert.deepEqual(exported.browser.routing.subscriptions.domainSources, [
    'future_service',
    'google_meet'
  ])
  assert.ok(validate(exported), JSON.stringify(validate.errors))
  config.browser.routing.subscriptions.domainSources = ['../evil']
  assert.equal(validate(config), false)
  assert.throws(() => M.importProfiles(config))
})

test('exclusive routing strategies validate and round-trip without discarding inactive controls', () => {
  const state = {
    ...M.defaults(),
    profiles: [M.profile({ id: 'server', host: 'proxy.example', port: 443 })],
    browserRouting: M.routing({
      enabled: true,
      strategy: 'lists',
      domains: ['manual.example'],
      subscriptions: { domainSources: ['youtube'] }
    })
  }
  const exported = M.exportConfig(state)
  assert.ok(validate(exported), JSON.stringify(validate.errors))
  const imported = M.importProfiles(exported, 'firefox')
  assert.equal(imported.browserRouting.strategy, 'lists')
  assert.deepEqual(imported.browserRouting.domains, ['manual.example'])
})

test('Chromium downgrades obsolete profile assignments and inactive tab settings', () => {
  const config = structuredClone(portable)
  config.browser = {
    routing: {
      enabled: true,
      strategy: 'profiles',
      mode: 'domains',
      sites: ['tab.example'],
      assignments: [{ domain: 'assigned.example', profileId: 'server' }]
    }
  }
  const imported = M.importProfiles(config, 'chromium')
  assert.equal(imported.browserRouting.strategy, 'manual')
  assert.deepEqual(imported.browserRouting.assignments, [])
  assert.equal(imported.unknownFields, true)
  assert.deepEqual(imported.browserRouting.sites, [])
  assert.equal(imported.unsupportedSplitProxy, true)
})

test('MASQUE import and export preserve the Firefox template and reject Chromium', () => {
  const config = structuredClone(portable)
  config.profiles[0].proxy.type = 'MASQUE'
  config.profiles[0].proxy.username = ''
  config.profiles[0].proxy.password = ''
  config.profiles[0].browser.masqueTemplate = '/custom/{target_host}/{target_port}/'
  assert.ok(validate(config), JSON.stringify(validate.errors))
  assert.ok(android(config), JSON.stringify(android.errors))
  const imported = M.importProfiles(config, 'firefox', true)
  const state = M.mergeImport(M.defaults(), imported)
  assert.equal(state.profiles[0].masqueTemplate, config.profiles[0].browser.masqueTemplate)
  const exported = M.exportConfig(state, true)
  assert.equal(exported.profiles[0].proxy.type, 'MASQUE')
  assert.equal(
    exported.profiles[0].browser.masqueTemplate,
    config.profiles[0].browser.masqueTemplate
  )
  assert.ok(validate(exported), JSON.stringify(validate.errors))
  assert.deepEqual(
    M.importProfiles(M.exportConfig(state, false), 'firefox', true).missingPasswords,
    []
  )
  assert.throws(() => M.importProfiles(config, 'chromium'), /errorMasqueUnsupported/)
})

test('disabled MASQUE imports skip profiles with a warning, including MASQUE-only files', () => {
  assert.equal(M.defaults().masqueEnabled, false)
  for (const data of [
    'masque://proxy.example:8443',
    {
      profiles: [
        { name: 'Experimental', proxy: { type: 'MASQUE', host: 'proxy.example', port: 443 } }
      ]
    }
  ]) {
    const result = M.importProfiles(data, 'firefox')
    assert.equal(result.skippedMasque, true)
    assert.equal(result.skipped.length, 1)
    assert.deepEqual(result.profiles, [])
    const state = M.defaults()
    assert.deepEqual(M.mergeImport(state, result), state)
  }
  const config = structuredClone(portable)
  config.profiles.push({
    id: 'masque',
    name: 'Experimental',
    proxy: { type: 'MASQUE', host: 'proxy.example', port: 443 }
  })
  const result = M.importProfiles(config, 'firefox')
  assert.equal(result.skippedMasque, true)
  assert.equal(result.profiles.length, portable.profiles.length)
  assert.equal(M.importProfiles(config, 'firefox', true).profiles.length, config.profiles.length)
})

test('root config subscriptions validate, round-trip and follow secret omission semantics', () => {
  const config = structuredClone(portable)
  config.subscription = {
    url: 'https://config.example/MegaProxy.json',
    username: 'reader',
    password: 'private',
    fallbackUrls: ['https://backup.example/MegaProxy.json']
  }
  assert.ok(validate(config), JSON.stringify(validate.errors))
  let state = M.mergeImport(M.defaults(), M.importProfiles(config, 'firefox'))
  assert.equal(state.subscription.enabled, true)
  assert.equal(state.subscription.intervalMinutes, 60)
  const exported = M.exportConfig(state)
  assert.ok(validate(exported), JSON.stringify(validate.errors))
  assert.equal(exported.subscription.password, undefined)
  assert.equal(M.exportConfig(state, true).subscription.password, 'private')
  state = M.mergeImport(state, M.importProfiles(exported, 'firefox'))
  assert.equal(state.subscription.password, 'private')
  const publicConfig = { ...config, subscription: { url: 'https://public.example/' } }
  const publicState = M.mergeImport(M.defaults(), M.importProfiles(publicConfig, 'firefox'))
  assert.equal(
    Object.hasOwn(
      M.mergeImport(publicState, M.importProfiles(publicConfig, 'firefox')).subscription,
      'password'
    ),
    false
  )
  const changed = structuredClone(exported)
  changed.subscription.url = 'https://other.example/MegaProxy.json'
  assert.equal(
    M.mergeImport(state, M.importProfiles(changed, 'firefox')).subscription.password,
    undefined
  )
  for (const invalid of [
    { url: 'http://config.example/' },
    { url: 'https://reader:secret@config.example/' },
    { url: 'https://config.example/#fragment' },
    { url: 'https://config.example/', username: 'user:other' },
    { url: 'https://config.example/', password: 'secret\n' },
    { url: 'https://config.example/', intervalMinutes: 0 },
    { url: 'https://config.example/', intervalMinutes: 1.5 },
    { url: 'https://config.example/', enabled: 'yes' },
    { url: 'https://config.example/', fallbackUrls: 'https://backup.example/' },
    { url: 'https://config.example/', fallbackUrls: ['http://backup.example/'] },
    { url: 'https://config.example/', fallbackUrls: ['https://CONFIG.example/'] },
    { url: 'https://config.example/', fallbackUrls: ['https://reader:secret@backup.example/'] }
  ]) {
    assert.throws(() => M.importProfiles({ ...config, subscription: invalid }, 'firefox'))
  }
  state = M.mergeImport(state, M.importProfiles({ ...config, subscription: null }, 'firefox'))
  assert.equal(state.subscription, null)
  assert.equal(M.exportConfig(state, true).subscription, undefined)
})
