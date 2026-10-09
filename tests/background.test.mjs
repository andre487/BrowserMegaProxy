import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'

const [core, background] = await Promise.all(
  ['core.js', 'background.js'].map(name => readFile(`extension/${name}`, 'utf8'))
)
test('background serializes writes, checks sender, rolls back failed apply and preserves inactive profiles', async () => {
  let listener
  let fail = false
  const proxyCalls = []
  let stored
  const listeners = {}
  const api = {
    runtime: {
      id: 'test',
      getURL: () => 'chrome-extension://test/',
      onMessage: {
        addListener: fn => {
          listener = fn
        }
      }
    },
    proxy: {
      settings: {
        get: async () => ({ levelOfControl: 'controllable_by_this_extension' }),
        set: async config => {
          proxyCalls.push(config)
          if (fail) {
            throw new Error('Proxy failure')
          }
        },
        clear: async () => {
          proxyCalls.push(null)
        }
      }
    },
    tabs: { query: async () => [], create: async () => ({ id: 1 }) },
    webRequest: Object.fromEntries(
      ['onAuthRequired', 'onCompleted', 'onErrorOccurred'].map(event => [
        event,
        {
          addListener(fn) {
            ;(listeners[event] ||= new Set()).add(fn)
          },
          removeListener(fn) {
            listeners[event].delete(fn)
          }
        }
      ])
    ),
    storage: {
      local: {
        get: async () => ({
          state: { statisticsEnabled: false, profiles: [], activeId: null, theme: 'dark' }
        }),
        set: async data => {
          stored = data
        }
      }
    }
  }
  const context = vm.createContext({
    browser: api,
    MEGA_TARGET: 'chromium',
    crypto,
    TextEncoder,
    btoa,
    URL,
    structuredClone
  })
  vm.runInContext(await readFile('extension/errors.js', 'utf8'), context)
  vm.runInContext(await readFile('extension/platform.js', 'utf8'), context)
  vm.runInContext(core, context)
  vm.runInContext(await readFile('extension/subscription-catalog.js', 'utf8'), context)
  vm.runInContext(await readFile('extension/subscriptions.js', 'utf8'), context)
  vm.runInContext(background, context)
  assert.equal(
    listener({ command: 'get' }, { id: 'untrusted' }, () => assert.fail()),
    false
  )
  assert.equal(
    listener({ command: 'get' }, { id: 'test', tab: { id: 1 }, url: 'https://evil.example/' }, () =>
      assert.fail()
    ),
    false
  )

  const send = message =>
    new Promise(resolve =>
      listener(message, { id: 'test', url: 'chrome-extension://test/popup.html' }, resolve)
    )

  assert.equal((await send({ command: 'get' })).state.language, 'auto')
  assert.equal((await send({ command: 'language', language: 'en' })).ok, true)
  assert.equal(stored.state.language, 'en')
  assert.equal(proxyCalls.length, 0)
  assert.equal((await send({ command: 'language', language: 'fr' })).error, 'errorLanguage')
  assert.equal((await send({ command: 'get' })).state.language, 'en')

  const saved = await send({
    command: 'save',
    profile: {
      host: 'proxy.example',
      port: 443,
      username: 'user',
      password: 'secret',
      knockHost: 'knock.example'
    }
  })
  const id = saved.state.profiles[0].id
  await Promise.all([
    send({ command: 'theme', theme: 'dark' }),
    send({ command: 'theme', theme: 'light' })
  ])
  assert.equal(proxyCalls.length, 0)
  assert.equal(stored.state.theme, 'light')
  fail = true
  assert.equal((await send({ command: 'activate', id })).ok, false)
  assert.equal((await send({ command: 'get' })).state.activeId, null)
  fail = false
  assert.equal((await send({ command: 'activate', id })).ok, true)
  assert.equal(stored.state.activeId, id)
  assert.equal((await send({ command: 'get' })).statistics, undefined)
  const completedListeners = listeners.onCompleted.size
  assert.equal((await send({ command: 'statistics', enabled: 'yes' })).ok, false)
  await send({ command: 'statistics', enabled: true })
  assert.equal(listeners.onCompleted.size, completedListeners + 1)
  const completed = [...listeners.onCompleted].at(-1)
  const failed = [...listeners.onErrorOccurred].at(-1)
  await completed({ requestId: 'one', url: 'https://public.example/', tabId: -1 })
  await failed({ requestId: 'two', url: 'https://public.example/', tabId: -1 })
  await completed({ requestId: 'direct', url: 'http://localhost/', tabId: -1 })
  await new Promise(resolve => setImmediate(resolve))
  let snapshot = (await send({ command: 'get' })).statistics
  assert.equal(snapshot.completed, 1)
  assert.equal(snapshot.failed, 1)
  // Even a previously dispatched callback cannot count after opt-out.
  await send({ command: 'statistics', enabled: false })
  await completed({ requestId: 'late', url: 'https://public.example/', tabId: -1 })
  assert.equal(listeners.onCompleted.size, completedListeners)
  assert.equal((await send({ command: 'get' })).statistics, undefined)
  assert.equal(stored.state.statisticsEnabled, false)
  await send({ command: 'statistics', enabled: true })
  snapshot = (await send({ command: 'get' })).statistics
  assert.equal(snapshot.completed, 0)
  assert.equal(snapshot.failed, 0)
  assert.equal(
    Object.hasOwn(context.MegaProxy.exportConfig(stored.state), 'statisticsEnabled'),
    false
  )
  await send({ command: 'statistics', enabled: false })

  const rejected = await send({
    command: 'import',
    data: {
      profiles: [
        { name: 'Good', proxy: { type: 'HTTPS', host: 'other.example', port: 443 } },
        { name: 'Bad', proxy: { type: 'HTTPS', host: 'bad/path', port: 443 } }
      ]
    }
  })
  assert.equal(rejected.ok, false)
  assert.equal((await send({ command: 'get' })).state.profiles.length, 1)
  await send({ command: 'delete', id })
  assert.equal(stored.state.activeId, null)
  assert.equal(proxyCalls.at(-1), null)
})
