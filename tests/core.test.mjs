import assert from 'node:assert/strict'
import { test } from 'node:test'
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
