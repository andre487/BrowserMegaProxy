import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../extension/errors.js'
import '../extension/platform.js'
import '../extension/core.js'
import '../extension/subscription-catalog.js'
import '../extension/subscriptions.js'

const M = globalThis.MegaProxy
const p = M.profile({
  host: 'Proxy.Example',
  port: 443,
  username: 'user',
  password: 'secret',
  bypass: 'internal.example',
  knockHost: 'knock.example'
})
const state = { profiles: [p], activeId: p.id }
test('SOCKS5 uses remote DNS, native Firefox credentials and Chromium SOCKS5 PAC', () => {
  const socks = M.profile(
    { host: 'socks.example', port: 1080, type: 'SOCKS5', username: 'user', password: 'secret' },
    'firefox'
  )
  const current = { profiles: [socks], activeId: socks.id }
  assert.deepEqual(M.proxyInfo('https://target.example/', current), {
    type: 'socks',
    host: socks.host,
    port: 1080,
    proxyDNS: true,
    username: 'user',
    password: 'secret'
  })
  assert.deepEqual(
    M.auth({ isProxy: true, challenger: { host: socks.host, port: 1080 } }, current, new Set()),
    {}
  )
  for (const target of ['firefox', 'chromium']) {
    assert.equal(globalThis.MegaPlatform.create(target).needsKnock(socks), false)
  }
  assert.throws(() => M.profile(socks, 'chromium'), /errorSocksAuthUnsupported/)
  const anonymous = M.profile({ ...socks, username: '', password: '' }, 'chromium')
  assert.equal(M.chromiumConfig(anonymous).rules.singleProxy.scheme, 'socks5')
  assert.match(
    M.chromiumConfig(anonymous, {
      browserRouting: M.routing({ enabled: true, domains: ['target.example'] })
    }).pacScript.data,
    /SOCKS5 socks.example:1080/
  )
  const ipv6 = M.profile({ ...anonymous, host: '::1' }, 'chromium')
  assert.match(
    M.chromiumConfig(ipv6, { downloadRouting: { hosts: ['target.example'], throughProxy: true } })
      .pacScript.data,
    /SOCKS5 \[::1\]:1080/
  )
  assert.throws(
    () => M.profile({ ...socks, password: 'ю'.repeat(128) }, 'firefox'),
    /errorSocksCredentials/
  )
  assert.equal(M.profile({ ...socks, password: 'x'.repeat(255) }, 'firefox').password.length, 255)
})

test('validation rejects endpoint, credentials and knock bypass mistakes', () => {
  for (const patch of [
    { host: 'https://proxy.example' },
    { host: 'proxy:443' },
    { port: 0 },
    { port: '443x' },
    { username: 'a:b' },
    { password: '\r\nsecret' },
    { type: 'ssh' },
    { allowInvalidProxyCertificate: true },
    { bypass: 'example', knockHost: 'knock.example' }
  ]) {
    assert.throws(() => M.profile({ ...p, ...patch }))
  }

  assert.equal(M.profile({ ...p, host: '[::1]' }).host, '::1')
})
test('saved Firefox credentials preauthenticate and domains use suffix-safe bypass', () => {
  assert.equal(
    M.proxyInfo('https://target.example', state).proxyAuthorizationHeader,
    'Basic dXNlcjpzZWNyZXQ='
  )
  assert.deepEqual(M.proxyInfo('https://app.internal.example', state), { type: 'direct' })
  assert.equal(M.proxyInfo('https://notinternal.example', state).host, p.host)
  assert.equal(
    M.proxyInfo('https://target.example', {
      profiles: [{ ...p, authMode: 'challenge' }],
      activeId: p.id
    }).proxyAuthorizationHeader,
    'Basic dXNlcjpzZWNyZXQ='
  )
  assert.deepEqual(M.proxyInfo('https://target.example', M.defaults()), { type: 'direct' })
  assert.equal(
    M.basic({ ...p, username: 'юзер', password: 'пароль' }),
    `Basic ${Buffer.from('юзер:пароль').toString('base64')}`
  )
})
test('auth only for matching proxy, once per request; never origin 401', () => {
  const attempts = new Set()
  const details = {
    requestId: '1',
    isProxy: true,
    challenger: { host: 'proxy.example', port: 443 }
  }
  assert.deepEqual(M.auth({ ...details, isProxy: false }, state, attempts), {})
  assert.deepEqual(
    M.auth({ ...details, challenger: { host: 'evil.example', port: 443 } }, state, attempts),
    {}
  )
  assert.deepEqual(
    M.auth({ ...details, challenger: { host: p.host, port: 80 } }, state, attempts),
    {}
  )
  assert.deepEqual(M.auth(details, state, attempts), {
    authCredentials: { username: 'user', password: 'secret' }
  })
  assert.deepEqual(M.auth(details, state, attempts), { cancel: true })
  assert.deepEqual(M.chromiumConfig(p, { bypassLocalNetworks: false }).rules.bypassList, [
    '<-loopback>',
    'internal.example',
    '*.internal.example'
  ])
})
test('imports server Android and FoxyProxy formats without retaining unsupported types', () => {
  const result = M.importProfiles({
    profiles: [
      {
        name: 'Server',
        proxy: { type: 'HTTPS', host: p.host, port: 443, username: 'u', password: 's' }
      },
      { name: 'SSH', proxy: { type: 'SSH' } }
    ]
  })
  assert.equal(result.profiles[0].name, 'Server')
  assert.deepEqual(result.skipped, ['SSH'])
  assert.equal(
    M.importProfiles({
      data: [{ title: 'Foxy', type: 'https', hostname: p.host, port: '443', color: '#b9c6f6' }]
    }).profiles[0].host,
    p.host
  )
  assert.throws(() => M.importProfiles({ profiles: [{ proxy: { type: 'SSH' } }] }))
})

test('MASQUE maps its template to Firefox and rejects Chromium', async () => {
  const p = M.profile({ type: 'MASQUE', host: 'proxy.example', port: 443 }, 'firefox')
  const current = { profiles: [p], activeId: p.id }
  assert.deepEqual(M.proxyInfo('https://target.example/', current), {
    type: 'masque',
    host: p.host,
    port: 443,
    masqueTemplate: '/.well-known/masque/udp/{target_host}/{target_port}/'
  })
  assert.throws(
    () => M.profile({ ...p, username: 'user', password: 'secret' }, 'firefox'),
    /errorMasqueAuthUnsupported/
  )
  assert.equal(M.needsKnock(p, 'firefox'), false)
  assert.equal(
    M.importProfiles('masque://proxy.example:8443', 'firefox').profiles[0].type,
    'masque'
  )
  assert.throws(() => M.profile(p, 'chromium'), /errorMasqueUnsupported/)
  assert.throws(() => M.chromiumConfig(p), /errorMasqueUnsupported/)
  for (const masqueTemplate of [
    '/bad/{target_host}/',
    '//other/{target_host}/{target_port}/',
    '/bad/{target_host}/{target_port}/{other}',
    '/bad/ {target_host}/{target_port}/',
    ['/bad/{target_host}/{target_port}/']
  ]) {
    assert.throws(() => M.profile({ ...p, masqueTemplate }, 'firefox'), /errorMasqueTemplate/)
  }
  const platform = globalThis.MegaPlatform.create('firefox', {
    runtime: { getBrowserInfo: async () => ({ version: '145.0' }) }
  })
  await assert.rejects(platform.apply(current), /errorMasqueVersion/)
})
