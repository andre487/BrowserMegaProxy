import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'

const catalogs = Object.fromEntries(
  await Promise.all(
    ['en', 'ru'].map(async locale => [
      locale,
      JSON.parse(await readFile(`extension/_locales/${locale}/messages.json`, 'utf8'))
    ])
  )
)
const source = await readFile('extension/i18n.js', 'utf8')

test('locale catalogs and browser UI language fallback support manual overrides', async () => {
  assert.deepEqual(Object.keys(catalogs.en).sort(), Object.keys(catalogs.ru).sort())
  for (const catalog of Object.values(catalogs)) {
    assert.ok(
      Object.values(catalog).every(({ message }) => typeof message === 'string' && message.length)
    )
  }

  let browserLanguage = 'ru-RU'
  const document = { documentElement: {}, querySelectorAll: () => [] }
  const context = vm.createContext({
    document,
    browser: {
      i18n: { getUILanguage: () => browserLanguage },
      runtime: { getURL: path => path }
    },
    fetch: async path => ({ ok: true, json: async () => catalogs[path.split('/')[1]] })
  })
  vm.runInContext(source, context)
  const i18n = context.MegaI18n
  await i18n.ready

  for (const [value, expected] of [
    ['ru', 'ru'],
    ['RU-ru', 'ru'],
    ['ru_RU', 'ru'],
    ['en-US', 'en'],
    ['fr', 'en'],
    ['uk', 'en']
  ]) {
    browserLanguage = value
    i18n.apply('auto')
    assert.equal(document.documentElement.lang, expected)
    assert.equal(i18n.t('disconnected'), catalogs[expected].disconnected.message)
  }

  i18n.apply('ru')
  assert.equal(document.documentElement.lang, 'ru')
  i18n.apply('en')
  assert.equal(i18n.t('errorHost'), catalogs.en.errorHost.message)
  assert.equal(i18n.t('importSkipped', 'SSH'), 'Imported; unsupported profiles skipped: SSH')
  assert.equal(i18n.t('importSkipped', '$& $1'), 'Imported; unsupported profiles skipped: $& $1')
  assert.equal(i18n.t('Unknown browser error'), 'Unknown browser error')
})
