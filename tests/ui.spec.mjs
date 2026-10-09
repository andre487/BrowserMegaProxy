/* global chrome */
import { expect, test } from '@playwright/test'
import { gzipSync } from 'node:zlib'

test.beforeEach(async ({ page, browserName, context }) => {
  await page.route(
    'https://api.github.com/repos/itdoginfo/allow-domains/git/trees/main?recursive=1',
    async route => {
      const sources = await page.evaluate(() => globalThis.MegaSubscriptionCatalog.sources)
      await route.fulfill({
        json: {
          truncated: false,
          tree: sources.map(source => ({ type: 'blob', path: source.path }))
        }
      })
    }
  )
  if (browserName === 'firefox') {
    await context.route('**/target.js', route =>
      route.fulfill({ contentType: 'text/javascript', body: 'globalThis.MEGA_TARGET = "firefox"' })
    )
  }
  // UI contract tests only. Actual extension and network tests live in extension.spec.mjs.
  await context.addInitScript(() => {
    const state = JSON.parse(localStorage.getItem('testState')) || {
      profiles: [],
      activeId: null,
      theme: 'system',
      language: 'auto',
      statisticsEnabled: true
    }
    globalThis.chrome = {
      extension: {
        isAllowedIncognitoAccess: async () => localStorage.getItem('privateAccess') === 'true'
      },
      permissions: { request: async () => true },
      tabs: { query: async () => [] },
      i18n: { getUILanguage: () => localStorage.getItem('browserLanguage') || 'ru-RU' },
      storage: {
        onChanged: {
          addListener: fn =>
            window.addEventListener('storage', event => {
              if (event.key === 'testState' && event.newValue) {
                fn({ state: { newValue: JSON.parse(event.newValue) } }, 'local')
              }
            })
        }
      },
      runtime: {
        getURL: path => new URL(path, location.href).href,
        openOptionsPage: async () => {
          location.href = new URL('options.html', location.href).href
        },
        sendMessage: async message => {
          ;(globalThis.testCommands ||= []).push(message.command)
          Object.assign(state, JSON.parse(localStorage.getItem('testState')) || {})
          const M = globalThis.MegaProxy
          if (message.command === 'check') {
            return {
              ok: true,
              connectionCheck: {
                stage: 'complete',
                mode: M.active(state)
                  ? 'proxy'
                  : state.connectionMode === 'direct'
                    ? 'direct'
                    : 'system',
                exitIp: '203.0.113.19',
                countryCode: 'DE',
                latencyMs: 10
              }
            }
          }
          if (message.command === 'webRTC') {
            state.webRTC = message.value
          }
          if (message.command === 'sync') {
            return {
              ok: true,
              state,
              syncOptions: { enabled: message.enabled, includePasswords: message.includePasswords }
            }
          }
          if (message.command === 'testRule') {
            const proxied = M.routed(message.url, state, message.tabUrl || message.url)
            const p = proxied && M.routeProfile(message.url, state, message.tabUrl || message.url)
            return { ok: true, proxied, profile: p ? { id: p.id, name: p.name } : null }
          }
          if (message.command === 'fetchConfig') {
            return { ok: true, data: await (await fetch(message.url)).text() }
          }
          if (message.command === 'save') {
            try {
              const p = M.profile(message.profile)
              state.profiles = [...state.profiles.filter(x => x.id !== p.id), p]
            } catch (error) {
              return { ok: false, error: error.message }
            }
          }

          if (message.command === 'connectionMode') {
            state.connectionMode = message.mode
            if (message.mode === 'proxy') {
              state.activeId ||= state.profiles[0]?.id || null
            }
          }

          if (message.command === 'telemetry') {
            return { ok: true }
          }
          if (message.command === 'network') {
            return { ok: true, entries: [] }
          }
          if (message.command === 'activate') {
            state.connectionMode = message.id ? 'proxy' : 'system'
            state.activeId = message.id
          }

          if (message.command === 'masqueEnabled') {
            state.masqueEnabled = message.enabled
          }
          if (message.command === 'statistics') {
            state.statisticsEnabled = message.enabled
          }

          if (message.command === 'theme') {
            state.theme = message.theme
          }

          if (message.command === 'language') {
            state.language = message.language
          }

          if (message.command === 'delete') {
            state.profiles = state.profiles.filter(p => p.id !== message.id)
            if (state.activeId === message.id) {
              state.activeId = null
            }
          }

          if (message.command === 'updateSubscriptions') {
            try {
              state.subscriptionCatalog = await globalThis.MegaSubscriptions.refreshCatalog(
                state.subscriptionCatalog,
                undefined,
                true
              )
              state.subscriptionCache = await globalThis.MegaSubscriptions.update(
                M.routing(state.browserRouting),
                state.subscriptionCache,
                undefined,
                globalThis.MegaSubscriptions.catalog(state.subscriptionCatalog)
              )
            } catch {
              state.subscriptionCache = { ...state.subscriptionCache, error: 'errorListDownload' }
            }
          }
          if (message.command === 'routing') {
            state.browserRouting = M.routing(message.routing)
          }
          if (message.command === 'currentSite') {
            if (localStorage.getItem('noCurrentSite') === 'true') {
              return { ok: true, currentSite: null }
            }
            const url = 'https://site.example.com/'
            return {
              ok: true,
              currentSite: {
                hostname: 'site.example.com',
                proxied: M.routed(url, state, url),
                profileId: M.routeProfile(url, state, url)?.id
              }
            }
          }
          if (message.command === 'addCurrentSite') {
            const routing = state.browserRouting || M.routing()
            const key = routing.mode === 'tabs' ? 'sites' : 'domains'
            state.browserRouting = M.routing({
              ...routing,
              enabled: true,
              strategy: key === 'sites' ? 'tabs' : 'manual',
              [key]: [...routing[key], 'site.example.com']
            })
          }
          if (message.command === 'toggleTab') {
            return { ok: true, currentSite: { hostname: 'site.example.com', proxied: false } }
          }
          if (message.command === 'previewImport') {
            try {
              const result = M.importProfiles(
                message.data,
                globalThis.MEGA_TARGET,
                state.masqueEnabled === true
              )
              return {
                ok: true,
                added: result.profiles.filter(p => !state.profiles.some(old => old.id === p.id))
                  .length,
                updated: result.profiles.filter(p => state.profiles.some(old => old.id === p.id))
                  .length,
                skipped: result.skipped,
                skippedMasque: result.skippedMasque,
                unknownFields: result.unknownFields || false,
                unsupportedSplitProxy: result.unsupportedSplitProxy || false,
                absent: result.config
                  ? state.profiles.filter(p => !result.profiles.some(next => next.id === p.id))
                  : []
              }
            } catch (error) {
              return { ok: false, error: error.message }
            }
          }
          if (message.command === 'export') {
            return { ok: true, config: M.exportConfig(state, message.includePasswords) }
          }
          if (message.command === 'clone') {
            const p = state.profiles.find(p => p.id === message.id)
            state.profiles.push({ ...p, id: crypto.randomUUID(), name: message.name })
          }
          if (message.command === 'move') {
            const index = state.profiles.findIndex(p => p.id === message.id)
            state.profiles.splice(
              message.position ?? index + message.direction,
              0,
              state.profiles.splice(index, 1)[0]
            )
          }

          if (message.command === 'bypassLocalNetworks') {
            state.bypassLocalNetworks = message.enabled
          }
          if (message.command === 'import') {
            const result = M.importProfiles(
              message.data,
              globalThis.MEGA_TARGET,
              state.masqueEnabled === true
            )
            Object.assign(state, M.mergeImport(state, result, message.removeIds))
            localStorage.setItem('testState', JSON.stringify(state))

            return {
              ok: true,
              state,
              skipped: result.skipped,
              unsupportedSplitProxy: result.unsupportedSplitProxy
            }
          }

          localStorage.setItem('testState', JSON.stringify(state))

          return { ok: true, state }
        }
      }
    }
  })
  await page.goto('http://127.0.0.1:8765/options.html')
})

test('private-window access status, browser instructions and refresh on return', async ({
  page,
  browserName
}) => {
  const status = page.locator('#private-access-status')
  const hint = page.locator('#private-access-hint')
  await expect(status).toHaveText('Доступ к приватным окнам: не разрешён')
  await expect(hint).toBeVisible()
  await expect(hint).toContainText(browserName === 'firefox' ? 'about:addons' : '«Подробнее»')

  await page.locator('#settings').evaluate(element => {
    element.open = true
  })
  await page.locator('#language').selectOption('en')
  await expect(status).toHaveText('Private-window access: not allowed')
  await expect(hint).toContainText(browserName === 'firefox' ? 'about:addons' : 'Details')

  await page.evaluate(() => {
    localStorage.setItem('privateAccess', 'true')
    window.dispatchEvent(new Event('focus'))
  })
  await expect(status).toHaveText('Private-window access: allowed')
  await expect(hint).toBeHidden()

  await page.evaluate(() => {
    chrome.extension.isAllowedIncognitoAccess = async () => {
      throw new Error('Unavailable')
    }
    window.dispatchEvent(new Event('focus'))
  })
  await expect(status).toHaveText('Private-window access: unable to check')
  await expect(hint).toBeVisible()
})

test('profile lifecycle, import, themes and responsive keyboard-accessible form', async ({
  page,
  browserName
}) => {
  await expect(page.getByRole('heading', { name: 'MegaProxy', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Добавить' }).click()
  await expect(page.getByLabel('Название')).toBeFocused()
  await page.getByLabel('Название').fill('Main')
  await page.getByLabel('Хост прокси').fill('proxy.example')
  await page.getByLabel('Логин').fill('user')
  await page.getByLabel('Пароль', { exact: true }).fill('secret')
  await page.getByRole('button', { name: 'Сохранить профиль' }).click()
  await expect(page.locator('.profile')).toHaveCount(1)

  await page.goto('http://127.0.0.1:8765/popup.html')
  await expect(page.locator('#profile-form')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Изменить' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Выбрать' }).click()
  await expect(page.locator('#connection')).toHaveText('Профиль: Main')

  await page.getByRole('button', { name: 'Настройки', exact: true }).click()
  await expect(page).toHaveURL(/options\.html$/)
  for (const [label, value] of [
    ['Пароль', 'new-secret'],
    ['Логин', 'new-user']
  ]) {
    await page.getByRole('button', { name: 'Изменить' }).click()
    await page.getByLabel(label, { exact: true }).fill(value)
    await page.getByRole('button', { name: 'Сохранить профиль' }).click()
    if (browserName === 'chromium') {
      await expect(page.locator('#notice')).toContainText('полностью закройте браузер')
    } else {
      await expect(page.locator('#notice')).toBeEmpty()
    }
  }
  await page.getByRole('button', { name: 'Изменить' }).click()
  await page.getByRole('button', { name: 'Сохранить профиль' }).click()
  await expect(page.locator('#notice')).toBeEmpty()
  await page.getByRole('button', { name: 'Изменить' }).click()
  await page.getByLabel('Хост прокси').fill('https://wrong.example')
  await page.getByRole('button', { name: 'Сохранить профиль' }).click()
  await expect(page.locator('#editor .dialog-error')).toContainText('без схемы')
  await page.locator('#cancel-profile').click()

  await page.locator('#settings > summary').click()
  await page.locator('#theme').selectOption('dark')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.locator('#theme').selectOption('light')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.emulateMedia({ colorScheme: 'dark' })
  if (browserName === 'firefox') {
    await page.locator('#theme').selectOption('system')
  } else {
    await expect(page.locator('#theme option[value=system]')).toHaveCount(0)
    await page.locator('#theme').selectOption('dark')
  }
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark')

  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  await page.goto('http://127.0.0.1:8765/popup.html')
  await page.getByRole('button', { name: 'Отключить', exact: true }).click()
  await expect(page.locator('#connection')).toHaveText('Системные настройки')
  await page.getByRole('button', { name: 'Настройки', exact: true }).click()
  await page.locator('.profile-menu > summary').click()
  await page.getByRole('button', { name: 'Удалить' }).click()
  await expect(page.locator('.profile')).toHaveCount(0)

  await page.locator('#import').setInputFiles({
    name: 'MegaProxy.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        profiles: [{ name: 'Imported', proxy: { type: 'HTTPS', host: 'proxy.example', port: 443 } }]
      })
    )
  })
  await expect(page.locator('#import-summary')).toHaveText(
    'Новых: 1 · Обновлений: 0 · Пропущено: 0'
  )
  await page.getByRole('button', { name: 'Применить импорт' }).click()
  await expect(page.locator('.profile')).toContainText('Imported')
  await expect(page.locator('body')).not.toContainText('secret')
})

for (const [browserLanguage, language, label] of [
  ['ru-RU', 'ru', 'Настройки'],
  ['en-US', 'en', 'Settings'],
  ['de-DE', 'en', 'Settings']
]) {
  test(`auto language follows browser UI ${browserLanguage}`, async ({ page }) => {
    await page.evaluate(value => localStorage.setItem('browserLanguage', value), browserLanguage)
    await page.reload()

    await expect(page.locator('body')).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', language)
    await expect(page.locator('header [data-i18n=settings]')).toHaveText(label)
    await expect(page.locator('#language')).toHaveValue('auto')
  })
}

test('manual language persists, preserves input and translates errors and dynamic profiles', async ({
  page
}) => {
  await page.getByRole('button', { name: 'Добавить' }).click()
  await page.getByLabel('Название').fill('Мой proxy')
  await page.getByLabel('Хост прокси').fill('https://wrong.example')
  await page.getByLabel('Пароль', { exact: true }).fill('secret')
  // A synchronized preference can change while an unsaved dialog is open.
  await page.evaluate(() => globalThis.send('language', { language: 'en' }))

  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Мой proxy')
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('secret')
  await expect(page.getByLabel('Name', { exact: true })).toHaveAttribute(
    'placeholder',
    'Main proxy'
  )
  await page.getByRole('button', { name: 'Save profile' }).click()
  await expect(page.locator('#notice')).toHaveText('Save profile: A password requires a username')
  await page.getByLabel('Username').fill('user')
  await page.getByRole('button', { name: 'Save profile' }).click()
  await expect(page.locator('#notice')).toContainText('without a scheme or path')

  await page.getByLabel('Proxy host').fill('proxy.example')
  await page.getByLabel('Username').fill('user')
  await page.getByRole('button', { name: 'Save profile' }).click()
  await expect(page.locator('.profile')).toContainText('Мой proxy')
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()

  await page.evaluate(() => localStorage.setItem('browserLanguage', 'ru-RU'))
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.locator('#language')).toHaveValue('en')
  await expect(page.locator('.profile')).toContainText('Мой proxy')

  await page.locator('#settings > summary').click()
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ru')
  await expect(page.getByRole('button', { name: 'Изменить' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Язык', exact: true }).selectOption('auto')
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru')

  await page.getByRole('combobox', { name: 'Язык', exact: true }).selectOption('en')
  await page.locator('#import').setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{bad')
  })
  await expect(page.locator('#notice')).toHaveText(
    'Read configuration for import: The file is not valid JSON'
  )
  await page.locator('#import').setInputFiles({
    name: 'mixed.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        profiles: [
          { name: 'Other', proxy: { type: 'HTTPS', host: 'other.example', port: 443 } },
          { name: 'SSH', proxy: { type: 'SSH' } }
        ]
      })
    )
  })
  await page.getByRole('button', { name: 'Apply import' }).click()
  await expect(page.locator('#notice')).toHaveText('Imported; unsupported profiles skipped: SSH')
})

test('profile colors, cloning, order, local bypass and portable export/import review', async ({
  page
}) => {
  await page.getByRole('button', { name: 'Добавить' }).click()
  await page.getByLabel('Название').fill('First')
  await page.getByLabel('Хост прокси').fill('proxy.example')
  await page.getByLabel('Логин', { exact: true }).fill('export-user')
  await page.getByLabel('Пароль', { exact: true }).fill('export-secret')
  await page.getByRole('combobox', { name: 'Цвет', exact: true }).selectOption('5')
  await page.getByLabel('Код страны').fill('US')
  await page.getByRole('button', { name: 'Сохранить профиль' }).click()
  await page.locator('.profile-menu > summary').click()
  await page.getByRole('button', { name: 'Дублировать' }).click()
  await expect(page.locator('.profile')).toHaveCount(2)
  await page.locator('.profile').last().locator('.profile-drag').focus()
  await page.keyboard.press('ArrowUp')
  await expect(page.locator('.profile').first()).toContainText('First (копия)')
  await page.locator('#settings > summary').click()
  await expect(page.locator('#bypass-local')).toBeChecked()
  await page.locator('#bypass-local').uncheck()
  await page.locator('#routing-settings > summary').click()
  await page.locator('#routing-form').click({ position: { x: 1, y: 1 } })
  await page.evaluate('routingSaves')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Экспорт настроек' }).click()
  const file = await download
  const { readFile } = await import('node:fs/promises')
  const config = JSON.parse(await readFile(await file.path(), 'utf8'))
  expect(config.schema).toBe('net.megaproxy487.config')
  expect(config.routing.bypassLocalNetworks).toBe(false)
  expect(config.profiles[0].countryCode).toBe('US')
  await expect(page.locator('#export-passwords')).toBeChecked()
  expect(config.profiles[0].proxy.password).toBe('export-secret')
  await page.locator('#export-passwords').uncheck()
  const passwordlessDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Экспорт настроек' }).click()
  const passwordlessFile = await passwordlessDownload
  const passwordlessConfig = JSON.parse(await readFile(await passwordlessFile.path(), 'utf8'))
  expect(passwordlessConfig.profiles[0].proxy.password).toBeUndefined()
  config.profiles = [config.profiles[0]]
  config.profiles[0].name = 'Updated'
  await page.locator('#import').setInputFiles({
    name: 'MegaProxy.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(config))
  })
  await expect(page.locator('#import-summary')).toContainText('Обновлений: 1')
  await expect(page.locator('#import-absent input')).not.toBeChecked()
  await page.getByRole('button', { name: 'Применить импорт' }).click()
  await expect(page.locator('.profile')).toHaveCount(2)
  await expect(page.locator('.profile').first()).toContainText('Updated')
})

test('language changes translate routing hints while preserving unsaved rules', async ({
  page
}) => {
  await page.locator('#routing-settings > summary').click()
  await page.locator('#routing-mode').selectOption('manual')
  await page.evaluate('routingSaves')
  await page.locator('#routing-list').fill('unsaved.example')
  await page.evaluate(() => globalThis.send('language', { language: 'en' }))
  for (const id of ['routing-hint', 'routing-patterns-hint']) {
    await expect(page.locator(`#${id}`)).not.toContainText(/[А-Яа-яЁё]/)
  }
  await expect(page.locator('#routing-list')).toHaveValue('unsaved.example')
})

test('ProxyList and SuperProxy text formats are reviewed before importing', async ({ page }) => {
  const selection = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Импорт настроек' }).click()
  await (
    await selection
  ).setFiles({
    name: 'SuperProxy.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      '# superproxy:proxylist:v1\nhttps://user:secret@proxy.example?title=Imported&cc=GB'
    )
  })
  await expect(page.locator('.profile')).toHaveCount(0)
  await page.getByRole('button', { name: 'Применить импорт' }).click()
  await expect(page.locator('.profile')).toContainText('Imported')
})

test('knock host stays editable and is saved with or without Firefox credentials', async ({
  page,
  browserName
}) => {
  await page.getByRole('button', { name: 'Добавить' }).click()
  await expect(page.getByLabel('Knock host')).toBeEnabled()
  await page.getByLabel('Логин').fill('user')
  await page.getByLabel('Пароль', { exact: true }).fill('secret')
  await expect(page.getByLabel('Knock host')).toBeEnabled()
  await page.getByLabel('Knock host').fill('knock.example.com')
  if (browserName === 'firefox') {
    await expect(page.locator('#knock-hint')).toContainText('не использует knock host')
  }
  await page.getByLabel('Название', { exact: true }).fill('Test')
  await page.getByLabel('Хост прокси').fill('proxy.example.com')
  await page.getByRole('button', { name: 'Сохранить профиль' }).click()
  await page.getByRole('button', { name: 'Изменить' }).click()
  await expect(page.getByLabel('Knock host')).toBeEnabled()
  await expect(page.getByLabel('Knock host')).toHaveValue('knock.example.com')
  if (browserName === 'firefox') {
    await page.getByLabel('Пароль', { exact: true }).fill('')
    await expect(page.getByLabel('Knock host')).toBeEnabled()
    await expect(page.locator('#knock-hint')).not.toContainText('не использует knock host')
    await page.getByLabel('Knock host').fill('other-knock.example.com')
    await page.getByRole('button', { name: 'Сохранить профиль' }).click()
    await page.getByRole('button', { name: 'Изменить' }).click()
    await expect(page.getByLabel('Knock host')).toHaveValue('other-knock.example.com')
  }
})

test('unknown and Android-only fields show a single general import warning', async ({ page }) => {
  const config = {
    schema: 'net.megaproxy487.config',
    version: 8,
    tls: { fingerprint: 'DEFAULT' },
    unknownOption: 'future',
    profiles: [
      {
        id: 'example',
        name: 'Example',
        proxy: { type: 'HTTPS', host: 'proxy.example', port: 443 },
        dns: { provider: 'QUAD9' },
        unknownProfileOption: true
      }
    ]
  }
  await page.locator('#import').setInputFiles({
    name: 'MegaProxy.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(config))
  })
  await expect(page.locator('#import-warnings')).toHaveText(
    'Конфигурация содержит неизвестные поля'
  )
  await page.getByRole('button', { name: 'Применить импорт' }).click()
  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('testState')))
  expect(state.portable.tls).toBeUndefined()
  expect(state.portable.unknownOption).toBeUndefined()
  expect(state.profiles[0].portable.dns).toBeUndefined()
  expect(state.profiles[0].portable.unknownProfileOption).toBeUndefined()
})

test('routing modes, wildcard lists and quick current-site actions follow browser capabilities', async ({
  page,
  browserName
}) => {
  await page.getByRole('button', { name: 'Добавить' }).click()
  await page.getByLabel('Хост прокси').fill('proxy.example')
  await page.getByRole('button', { name: 'Сохранить профиль' }).click()
  await page.locator('#routing-settings > summary').click()
  await page.locator('#routing-mode').selectOption('manual')
  await page.locator('#routing-list').fill('example.net\n*.example.org')
  if (browserName === 'firefox') {
    await expect(page.locator('#routing-mode')).toBeVisible()
  } else {
    await expect(page.locator('#routing-mode')).toBeVisible()
    await expect(page.locator('#routing-mode option[value=tabs]')).toBeHidden()
  }
  await page.locator('#routing-form').click({ position: { x: 1, y: 1 } })
  await page.evaluate('routingSaves')
  await page.reload()
  await page.locator('#routing-settings > summary').click()
  await expect(page.locator('#routing-list')).toHaveValue('example.net\n*.example.org')
  if (browserName === 'firefox') {
    await page.locator('#routing-mode').selectOption('tabs')
    await page.locator('#routing-list').fill('site.example.com')
    await page.locator('#routing-form').click({ position: { x: 1, y: 1 } })
    await page.evaluate('routingSaves')
  }
  await page.goto('http://127.0.0.1:8765/popup.html')
  await page.getByRole('button', { name: 'Выбрать', exact: true }).click()
  await expect(page.locator('#current-site')).toHaveText('site.example.com')
  if (browserName === 'firefox') {
    await expect(page.locator('#toggle-tab')).toBeVisible()
    await page.locator('#toggle-tab').click()
    await expect(page.locator('#toggle-tab')).toHaveText('Прокси для этой вкладки')
  } else {
    await expect(page.locator('#toggle-tab')).toBeHidden()
  }
  await page.locator('#add-current-site').click()
  const routing = await page.evaluate(
    () => JSON.parse(localStorage.getItem('testState')).browserRouting
  )
  expect(routing.enabled).toBe(true)
  expect(routing[browserName === 'firefox' ? 'sites' : 'domains']).toContain('site.example.com')
  await page.getByRole('button', { name: 'Настройки', exact: true }).click()
  await page.locator('#routing-settings > summary').click()
  if (browserName === 'firefox') {
    await page.locator('#routing-mode').selectOption('manual')
    await expect(page.locator('#routing-list')).toHaveValue('example.net\n*.example.org')
  }
})

test('Firefox split-proxy imports show a Chromium warning and retain only supported routing', async ({
  page,
  browserName
}) => {
  const config = {
    schema: 'net.megaproxy487.config',
    version: 8,
    browser: {
      routing: {
        enabled: true,
        mode: 'tabs',
        domains: ['*.example.org'],
        sites: ['site.example.com']
      }
    },
    profiles: [{ id: 'server', proxy: { type: 'HTTPS', host: 'proxy.example', port: 443 } }]
  }
  await page.locator('#import').setInputFiles({
    name: 'MegaProxy.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(config))
  })
  if (browserName === 'chromium') {
    await expect(page.locator('#import-warnings')).toContainText('не поддерживается в Chromium')
  } else {
    await expect(page.locator('#import-warnings')).toHaveText('')
  }
  await page.getByRole('button', { name: 'Применить импорт' }).click()
  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('testState')))
  expect(state.browserRouting.mode).toBe(browserName === 'firefox' ? 'tabs' : 'domains')
  expect(state.browserRouting.sites).toEqual(browserName === 'firefox' ? ['site.example.com'] : [])
  expect(state.browserRouting.domains).toEqual(['*.example.org'])
  if (browserName === 'chromium') {
    await expect(page.locator('#notice')).toContainText('не поддерживается в Chromium')
  }
})

test('domain subscriptions preserve inactive manual rules, warn on truncation and retain cached lists on failure', async ({
  page
}) => {
  const domains = Array.from(
    { length: 1002 },
    (_, index) => `site${String(index).padStart(4, '0')}.example`
  )
  let offline = false
  await page.route('https://raw.githubusercontent.com/**', async route => {
    if (offline) {
      await route.abort()
      return
    }
    const url = route.request().url()
    const body = url.endsWith('current.version.txt')
      ? 'ABCDE'
      : url.endsWith('current.csv.gz')
        ? gzipSync('1,site1001.example\n2,site1000.example\n')
        : domains.join('\n')
    await route.fulfill({
      body,
      contentType: 'application/octet-stream',
      headers: { 'Access-Control-Allow-Origin': '*' }
    })
  })
  await page.route('https://tranco-list.eu/**', route => route.abort())
  await page.locator('#routing-settings > summary').click()
  await page.locator('#routing-mode').selectOption('lists')
  await expect(page.locator('#update-lists')).toBeEnabled()
  await page.locator('#routing-mode').selectOption('manual')
  await page.locator('#routing-mode').selectOption('manual')
  await page.locator('#routing-list').fill('manual.example')
  await page.locator('#routing-mode').selectOption('lists')
  await page.locator('#subscription-sources').getByLabel('YouTube', { exact: true }).check()
  await page.locator('#lists-auto').uncheck()
  await page.locator('#lists-proxy').check()
  await page.locator('#routing-form').click({ position: { x: 1, y: 1 } })
  await page.evaluate('routingSaves')

  await page.locator('#update-lists').click()
  await expect(page.locator('#lists-status')).toContainText('Действующих правил: 1000')
  await expect(page.locator('#lists-warning')).toContainText('Отброшено правил:')
  let state = await page.evaluate(() => JSON.parse(localStorage.getItem('testState')))
  expect(state.browserRouting.domains).toEqual(['manual.example'])
  expect(state.browserRouting.subscriptions.domainSources).toEqual(['youtube'])
  expect(state.browserRouting.subscriptions.siteSources).toEqual([])
  expect(state.browserRouting.subscriptions.throughProxy).toBe(true)
  expect(state.subscriptionCache.domains).toHaveLength(1000)
  expect(state.subscriptionCache.domains[0]).toBe('**.site1001.example')
  expect(state.subscriptionCache.counts.domains.dropped).toBe(2)
  expect(state.subscriptionCache.rankingId).toBe('ABCDE')
  const updatedAt = state.subscriptionCache.updatedAt
  offline = true
  await page.locator('#update-lists').click()
  await expect(page.locator('#lists-warning')).toContainText('сохранена последняя успешная версия')
  state = await page.evaluate(() => JSON.parse(localStorage.getItem('testState')))
  expect(state.subscriptionCache.updatedAt).toBe(updatedAt)
  expect(state.subscriptionCache.domains).toHaveLength(1000)
  await page.reload()
  await page.locator('#routing-settings > summary').click()
  await page.locator('#routing-mode').selectOption('lists')
  await expect(page.locator('#lists-proxy')).toBeChecked()
  await expect(page.locator('#lists-auto')).not.toBeChecked()
  await expect(page.locator('#lists-warning')).toContainText('сохранена последняя успешная версия')
  await expect(page.locator('#statistics')).toBeVisible()
})

test('statistics and network monitoring default on and opt-out persists locally', async ({
  page
}) => {
  await expect(page.locator('#statistics')).toBeVisible()
  await page.locator('#settings > summary').click()
  await expect(page.locator('[data-i18n=statisticsPrivacy]')).toContainText(
    'никуда не отправляются'
  )
  await page.locator('#statistics-enabled').check()
  await expect(page.locator('#statistics')).toBeVisible()
  await expect(page.locator('#statistics')).toContainText('хранится локально')
  await page.reload()
  await expect(page.locator('#statistics')).toBeVisible()
  await page.goto('http://127.0.0.1:8765/popup.html')
  await expect(page.locator('#statistics')).toBeVisible()
  await page.goto('http://127.0.0.1:8765/options.html')
  await page.locator('#settings > summary').click()
  await page.locator('#statistics-enabled').uncheck()
  await expect(page.locator('#statistics')).toBeHidden()
  await page.goto('http://127.0.0.1:8765/popup.html')
  await expect(page.locator('#statistics')).toBeHidden()
})

test('privacy, sync defaults, rule tester and URL review', async ({ page }) => {
  await page.goto('http://127.0.0.1:8765/options.html')
  await page.locator('#settings > summary').click()
  await expect(page.locator('#sync-enabled')).toBeChecked()
  await expect(page.locator('#sync-passwords')).toBeChecked()
  await page.locator('#sync-passwords').uncheck()
  await expect(page.locator('#sync-passwords')).not.toBeChecked()
  await page.locator('#sync-enabled').uncheck()
  await expect(page.locator('#sync-passwords')).toBeDisabled()
  await page.locator('#webrtc').selectOption('disable_non_proxied_udp')
  await expect(page.locator('#webrtc')).toHaveValue('disable_non_proxied_udp')
  const config = {
    schema: 'net.megaproxy487.config',
    version: 8,
    profiles: [
      { id: 'remote', name: 'Remote', proxy: { type: 'HTTPS', host: 'proxy.example', port: 443 } }
    ]
  }
  await page.route('https://config.example/MegaProxy.json', route =>
    route.fulfill({ json: config })
  )
  await page.locator('#open-url-import').click()
  await page.locator('#config-url').fill('https://config.example/MegaProxy.json')
  await page.locator('#import-url-form button[type=submit]').click()
  await expect(page.locator('#import-review')).toBeVisible()
  await expect(page.locator('.profile')).toHaveCount(0)
  await page.locator('#apply-import').click()
  await expect(page.locator('.profile')).toHaveCount(1)
  await page.goto('http://127.0.0.1:8765/popup.html')
  await page.locator('.profile button').click()
  await page.goto('http://127.0.0.1:8765/options.html')
  await page.locator('#routing-settings > summary').click()
  await page.locator('#routing-mode').selectOption('manual')
  await expect(page.locator('#routing-mode option[value=profiles]')).toHaveCount(0)
  await page.locator('#routing-list').fill('**.example.com')
  await page.locator('#routing-form').click({ position: { x: 1, y: 1 } })
  await page.evaluate('routingSaves')
  await expect(page.locator('#rule-tester')).toBeVisible()
  await page.locator('#rule-url').fill('https://child.example.com/')
  await page.locator('#rule-test-form button').click()
  await expect(page.locator('#rule-result')).toContainText('Remote')
  await page.locator('#rule-url').fill('https://unselected.example.net/')
  await page.locator('#rule-test-form button').click()
  await expect(page.locator('#rule-result')).toHaveText('Прямое подключение')
})

test('ZeroOmega JSON imports profiles and a domain list through review', async ({ page }) => {
  const config = {
    schemaVersion: 2,
    '+Proxy': {
      name: 'Proxy',
      profileType: 'FixedProfile',
      fallbackProxy: { scheme: 'https', host: 'proxy.example', port: 443 },
      auth: { all: { username: 'user', password: 'secret' } }
    },
    '+Unsupported': {
      name: 'Unsupported',
      profileType: 'FixedProfile',
      fallbackProxy: { scheme: 'socks4', host: 'socks.example', port: 1080 }
    },
    '+Auto': {
      name: 'Auto',
      profileType: 'SwitchProfile',
      defaultProfileName: 'direct',
      rules: [
        {
          condition: { conditionType: 'HostWildcardCondition', pattern: '*.example.com' },
          profileName: 'Proxy'
        },
        {
          condition: { conditionType: 'HostWildcardCondition', pattern: 'exact.example.org' },
          profileName: 'Proxy'
        }
      ]
    }
  }
  await page.locator('#import').setInputFiles({
    name: 'ZeroOmega.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(config))
  })
  await expect(page.locator('#import-review')).toBeVisible()
  await expect(page.locator('#import-warnings')).toContainText(
    'Конфигурация содержит неизвестные поля'
  )
  await expect(page.locator('.profile')).toHaveCount(0)
  await page.locator('#apply-import').click()
  await expect(page.locator('.profile')).toHaveCount(1)
  await page.locator('#routing-settings > summary').click()
  await expect(page.locator('.assignment')).toHaveCount(0)
  await expect(page.locator('#routing-list')).toHaveValue('**.example.com\nexact.example.org')
  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('testState')))
  expect(state.activeId).toBeNull()
  expect(state.browserRouting.assignments).toEqual([])
  expect(state.profiles[0].password).toBe('secret')
})

test('network monitor filters errors, selects failed domains and hides on opt-out', async ({
  page
}) => {
  await page.locator('#new').click()
  await page.getByLabel('Хост прокси').fill('proxy.example')
  await page.getByRole('button', { name: 'Сохранить профиль' }).click()
  await page.getByRole('button', { name: 'Выбрать', exact: true }).click()
  await page.locator('#routing-settings > summary').click()
  await page.locator('#routing-mode').selectOption('manual')
  await page.evaluate(() => {
    chrome.tabs.query = async () => [{ id: 7, url: 'https://page.example/', title: 'Example tab' }]
    const original = chrome.runtime.sendMessage
    chrome.runtime.sendMessage = async message => {
      if (message.command === 'network') {
        return {
          ok: true,
          entries: [
            { domain: 'failed.example', type: 'image', failed: true, error: 'HTTP 503' },
            { domain: 'good.example', type: 'script', failed: false, status: 200 }
          ]
        }
      }
      if (message.command === 'addFailedDomains') {
        globalThis.selectedNetworkDomains = message
      }
      return original(message)
    }
  })
  await page.locator('#network-panel > summary').click()
  await expect(page.locator('.network-row')).toHaveCount(1)
  await expect(page.locator('#network-rows')).toContainText('failed.example')
  await page.locator('#network-failed').uncheck()
  await expect(page.locator('.network-row')).toHaveCount(2)
  await expect(page.locator('.network-row input[value="good.example"]')).toBeDisabled()
  for (const width of [320, 1200]) {
    await page.setViewportSize({ width, height: 900 })
    const row = page.locator('.network-row').first()
    const checkbox = await row.locator('input').boundingBox()
    const text = await row.locator('span').boundingBox()
    expect(checkbox.width).toBeLessThanOrEqual(24)
    expect(text.x - checkbox.x - checkbox.width).toBeGreaterThanOrEqual(7)
    expect(text.x - checkbox.x - checkbox.width).toBeLessThanOrEqual(10)
    expect(text.x + text.width).toBeLessThanOrEqual(width)
  }
  await page.locator('.network-row input[value="failed.example"]').check()
  await page.locator('#network-add').click()
  expect(await page.evaluate(() => globalThis.selectedNetworkDomains.domains)).toEqual([
    'failed.example'
  ])
  await page.locator('#settings > summary').click()
  await page.locator('#statistics-enabled').uncheck()
  await expect(page.locator('#network-panel')).toBeHidden()
})

test('default statistics refresh preserves unsaved routing fields', async ({ page }) => {
  await page.locator('#routing-settings > summary').click()
  await page.locator('#routing-mode').selectOption('manual')
  await page.locator('#routing-list').fill('unsaved.example')
  await page.waitForTimeout(5500)
  await expect(page.locator('#routing-list')).toHaveValue('unsaved.example')
})

test('popup has one content scrollbar and keeps settings visible in either theme', async ({
  page
}) => {
  for (const theme of ['light', 'dark']) {
    await page.evaluate(
      theme =>
        localStorage.setItem(
          'testState',
          JSON.stringify({
            profiles: Array.from({ length: 20 }, (_, index) => ({
              id: String(index),
              name: `Long profile name ${index}`,
              type: 'https',
              host: 'long-proxy-host.example.com',
              port: 443,
              color: index % 12,
              username: 'user',
              password: 'password',
              knockHost: 'knock.example.com',
              bypass: []
            })),
            activeId: '0',
            connectionMode: 'proxy',
            theme,
            language: 'ru',
            statisticsEnabled: true
          })
        ),
      theme
    )
    await page.setViewportSize({ width: 380, height: 600 })
    await page.goto('http://127.0.0.1:8765/popup.html')
    await expect(page.locator('.profile')).toHaveCount(20)
    await expect(page.locator('#check')).toBeEnabled()
    await expect(page.locator('#open-settings')).toBeInViewport()
    await expect(page.locator('#open-network')).toHaveCount(0)
    await expect(page.locator('#open-settings svg')).toBeVisible()
    expect(await page.locator('#open-settings').innerText()).toBe('')
    expect((await page.locator('#profiles').boundingBox()).height).toBeGreaterThan(156)
    await expect(page.locator('#profiles')).toHaveCSS('max-height', 'none')
    await expect(page.locator('#profiles')).toHaveCSS('overflow-y', 'clip')
    expect(
      await page
        .locator('#profiles')
        .evaluate(element => element.scrollHeight - element.clientHeight)
    ).toBeLessThanOrEqual(1)
    expect(
      await page
        .locator('.popup-content')
        .evaluate(element => element.scrollHeight > element.clientHeight)
    ).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(
      600
    )
    await page
      .locator('.popup-content')
      .evaluate(element => (element.scrollTop = element.scrollHeight))
    await expect(page.locator('#check')).toBeInViewport()
    await expect(page.locator('#open-settings')).toBeInViewport()
    await page.getByRole('button', { name: 'Настройки', exact: true }).click()
    await expect(page).toHaveURL(/options\.html$/)
  }
})

test('options reflow at 320 pixels with all sections expanded in both languages and themes', async ({
  page
}) => {
  await page.setViewportSize({ width: 320, height: 800 })
  for (const language of ['ru', 'en']) {
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        ({ language, theme }) =>
          localStorage.setItem(
            'testState',
            JSON.stringify({
              profiles: [
                {
                  id: 'one',
                  name: 'Very long profile name for narrow windows',
                  type: 'https',
                  host: 'proxy.example.com',
                  port: 443,
                  color: 0,
                  bypass: []
                }
              ],
              activeId: null,
              language,
              theme,
              statisticsEnabled: true
            })
          ),
        { language, theme }
      )
      await page.reload()
      await expect(page.locator('.profile')).toHaveCount(1)
      await page.locator('#new').click()
      await page.evaluate(() =>
        document
          .querySelectorAll('details:not(.profile-menu)')
          .forEach(element => (element.open = true))
      )
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        320
      )
      const exportButton = await page.locator('#export').boundingBox()
      const passwords = await page.locator('#export-passwords').boundingBox()
      const imports = await page.locator('.import-actions').boundingBox()
      const passwordLabel = await page.locator('.export-actions label').boundingBox()
      expect(exportButton.y).toBeGreaterThanOrEqual(imports.y + imports.height)
      expect(exportButton.x).toBe(imports.x)
      expect(passwordLabel.x - exportButton.x - exportButton.width).toBeCloseTo(14)
      expect(
        Math.abs(exportButton.y + exportButton.height / 2 - passwords.y - passwords.height / 2)
      ).toBeLessThan(1)
      await expect(page.locator('#profile-color option').first()).toHaveText(
        language === 'ru' ? 'Красный' : 'Red'
      )
    }
  }
})

test('profile actions menu supports keyboard activation and dismissal', async ({ page }) => {
  await page.locator('#new').click()
  await page.getByLabel('Название').fill('Menu profile')
  await page.getByLabel('Хост прокси').fill('proxy.example.com')
  await page.getByRole('button', { name: 'Сохранить профиль' }).click()
  const summary = page.locator('.profile-menu > summary')
  await summary.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Дублировать' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Дублировать' })).toBeHidden()
  await expect(summary).toBeFocused()
  await summary.click()
  await page.locator('h1').click()
  await expect(page.getByRole('button', { name: 'Дублировать' })).toBeHidden()
})

test('HTML pages load vector logos and favicons', async ({ page }) => {
  for (const name of ['popup', 'options', 'log']) {
    await page.goto(`http://127.0.0.1:8765/${name}.html`)
    const icon = page.locator('link[rel="icon"]')
    await expect(icon).toHaveAttribute('href', 'icons/icon.svg')
    await expect(icon).toHaveAttribute('type', 'image/svg+xml')
    await expect(icon).toHaveAttribute('sizes', 'any')
    const response = await page.request.get('http://127.0.0.1:8765/icons/icon.svg')
    expect(response.ok()).toBe(true)
    expect(response.headers()['content-type']).toBe('image/svg+xml')
    expect(await response.text()).not.toContain('<image')
    const loaded = await page.evaluate(async () => {
      const icon = new Image()
      icon.src = document.querySelector('link[rel="icon"]').href
      await icon.decode()
      const brand = document.querySelector('.brand')
      if (brand) {
        await brand.decode()
      }
      return { width: icon.naturalWidth, brand: brand ? brand.getAttribute('src') : null }
    })
    expect(loaded).toEqual({ width: 512, brand: name === 'log' ? null : 'icons/icon.svg' })
  }
})

test('toolbar icons have crisp white marks and transparent space for the profile dot', async ({
  page
}) => {
  for (const size of [16, 24, 32, 48, 64]) {
    const result = await page.evaluate(async size => {
      const image = new Image()
      image.src = `/icons/toolbar${size}.png`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = size
      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0)
      return {
        width: image.naturalWidth,
        height: image.naturalHeight,
        cornerAlpha: context.getImageData(0, 0, 1, 1).data[3],
        centerAlpha: context.getImageData(size / 2, size / 2, 1, 1).data[3],
        rightAlpha: context.getImageData(size - 1, size / 2, 1, 1).data[3],
        bottomAlpha: context.getImageData(size / 2, size - 1, 1, 1).data[3],
        leg: [
          ...context.getImageData(Math.floor((size * 3) / 16), Math.floor((size * 11) / 16), 1, 1)
            .data
        ]
      }
    }, size)
    expect(result).toMatchObject({
      width: size,
      height: size,
      centerAlpha: 255,
      rightAlpha: 0,
      bottomAlpha: 0
    })
    expect(result.leg).toEqual([255, 255, 255, 255])
    expect(result.cornerAlpha).toBeLessThan(255)
  }
})

test('manifest icons have matching rounded corners and small icons match toolbar icons', async ({
  page
}) => {
  for (const size of [16, 32, 48, 128]) {
    const result = await page.evaluate(async size => {
      const image = new Image()
      image.src = `/icons/icon${size}.png`
      await image.decode()
      const context = document.createElement('canvas').getContext('2d')
      context.canvas.width = context.canvas.height = size
      context.drawImage(image, 0, 0)
      const pixels = context.getImageData(0, 0, size, size).data
      let matches = true
      if (size === 16 || size === 32) {
        const toolbar = new Image()
        toolbar.src = `/icons/toolbar${size}.png`
        await toolbar.decode()
        context.clearRect(0, 0, size, size)
        context.drawImage(toolbar, 0, 0)
        matches = context
          .getImageData(0, 0, size, size)
          .data.every((value, index) => value === pixels[index])
      }
      return {
        width: image.naturalWidth,
        height: image.naturalHeight,
        cornerAlpha: pixels[3],
        centerAlpha: pixels[(Math.floor(size / 2) * size + Math.floor(size / 2)) * 4 + 3],
        matches
      }
    }, size)
    expect(result).toMatchObject({ width: size, height: size, centerAlpha: 255, matches: true })
    expect(result.cornerAlpha).toBeLessThan(255)
  }
})

test('input boundaries remain distinguishable in both themes', async ({ page }) => {
  for (const theme of ['light', 'dark']) {
    await page.locator('#settings').evaluate(element => (element.open = true))
    await page.locator('#theme').selectOption(theme)
    const contrast = await page.locator('#theme').evaluate(element => {
      const style = getComputedStyle(element)
      const luminance = color => {
        const channels = color
          .match(/[\d.]+/g)
          .slice(0, 3)
          .map(Number)
          .map(value => {
            const channel = value / 255
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
          })
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
      }
      const border = luminance(style.borderTopColor)
      const background = luminance(style.backgroundColor)
      return (Math.max(border, background) + 0.05) / (Math.min(border, background) + 0.05)
    })
    expect(contrast).toBeGreaterThanOrEqual(3)
  }
})

test('current-site block explains unavailable tabs and domain routing without global-mode jargon', async ({
  page
}) => {
  await page.evaluate(() => localStorage.setItem('noCurrentSite', 'true'))
  await page.goto('http://127.0.0.1:8765/popup.html')
  await expect(page.locator('#current-site')).toContainText('На этой вкладке нет сайта')
  await expect(page.locator('#routing-summary')).toBeHidden()
  await expect(page.locator('#add-current-site')).toBeHidden()
  await page.evaluate(() => {
    localStorage.removeItem('noCurrentSite')
    localStorage.setItem(
      'testState',
      JSON.stringify({
        profiles: [
          {
            id: 'main',
            name: 'Work',
            type: 'https',
            host: 'proxy.example',
            port: 443,
            color: 0,
            bypass: []
          }
        ],
        activeId: 'main',
        connectionMode: 'proxy',
        language: 'ru',
        statisticsEnabled: false
      })
    )
  })
  await page.reload()
  await expect(page.locator('#site-actions')).toBeHidden()
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('testState'))
    state.browserRouting = {
      enabled: true,
      mode: 'domains',
      domains: ['another.example'],
      sites: [],
      assignments: []
    }
    state.subscriptionCache = {
      sourceKey: globalThis.MegaSubscriptions.sourceKey(globalThis.MegaSubscriptions.options()),
      counts: { domains: { dropped: 1162 } }
    }
    localStorage.setItem('testState', JSON.stringify(state))
  })
  await page.reload()
  await expect(page.locator('#site-actions')).toBeVisible()
  await expect(page.locator('#site-warning')).toBeHidden()
  await expect(page.locator('#add-current-site')).toHaveText('Добавить сайт в правила')
  await expect(page.locator('#routing-summary')).toHaveText(
    'Для этого домена: напрямую, без прокси'
  )
  await page.locator('#disconnect').click()
  await expect(page.locator('#site-actions')).toBeHidden()
  await page.locator('#connection-mode').selectOption('direct')
  await expect(page.locator('#site-actions')).toBeHidden()
})

test('popup scrolls to completed check results once, after the requested check finishes', async ({
  page
}) => {
  await page.evaluate(() => {
    localStorage.setItem(
      'testState',
      JSON.stringify({
        profiles: Array.from({ length: 30 }, (_, index) => ({
          id: String(index),
          name: `Profile ${index}`,
          type: 'HTTP',
          host: 'proxy.example',
          port: 8080,
          color: index % 12
        }))
      })
    )
  })
  await page.goto('http://127.0.0.1:8765/popup.html')
  await expect(page.locator('#check')).toBeEnabled()
  await page.evaluate(() => {
    const original = chrome.runtime.sendMessage
    chrome.runtime.sendMessage = async message => {
      if (message.command === 'check') {
        await new Promise(resolve => {
          globalThis.finishCheck = resolve
        })
      }
      return original(message)
    }
  })
  await page.locator('#check').click()
  await expect.poll(() => page.evaluate(() => typeof globalThis.finishCheck)).toBe('function')
  const content = page.locator('.popup-content')
  await content.evaluate(element => {
    element.scrollTop = 0
  })
  expect(await content.evaluate(element => element.scrollTop)).toBe(0)
  await page.evaluate(() => globalThis.finishCheck())
  await expect(page.locator('#check-result')).toContainText('203.0.113.19')
  await expect
    .poll(() =>
      content.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)
    )
    .toBeLessThanOrEqual(1)
  const visible = await page.locator('#check-result').evaluate(element => {
    const result = element.getBoundingClientRect()
    const viewport = element.closest('.popup-content').getBoundingClientRect()
    return result.top >= viewport.top && result.bottom <= viewport.bottom
  })
  expect(visible).toBe(true)
  await content.evaluate(element => {
    element.scrollTop = 0
  })
  await page.evaluate('renderCheck(); renderCheck()')
  expect(await content.evaluate(element => element.scrollTop)).toBe(0)
})

test('connection checks are available without profiles in Direct and System modes', async ({
  page
}) => {
  await page.goto('http://127.0.0.1:8765/popup.html')
  for (const mode of ['direct', 'system']) {
    await page.locator('#connection-mode').selectOption(mode)
    await expect(page.locator('#check')).toBeEnabled()
    await page.locator('#check').click()
    await expect(page.locator('#check-result')).toContainText('203.0.113.19')
    await expect(page.locator('#check')).toBeEnabled()
  }
  await page.locator('#open-settings').click()
  await expect(page.locator('#check')).toBeEnabled()
  await page.locator('#check').click()
  await expect(page.locator('#check-result')).toContainText('203.0.113.19')
})

test('dialogs cancel safely, connection check comes first and build metadata is visible', async ({
  page
}) => {
  await expect(page.locator('#editor')).toBeHidden()
  await page.locator('#new').click()
  await expect(page.getByLabel('Название')).toBeFocused()
  await page.getByLabel('Хост прокси').fill('discard.example')
  await page.keyboard.press('Escape')
  await expect(page.locator('#editor')).toBeHidden()
  await expect(page.locator('#new')).toBeFocused()
  await expect(page.locator('.profile')).toHaveCount(0)
  await page.locator('#open-url-import').click()
  await expect(page.locator('#url-import')).toBeVisible()
  await page.locator('#cancel-url-import').click()
  await expect(page.locator('#url-import')).toBeHidden()
  await expect(page.locator('#open-url-import')).toBeFocused()
  await expect(page.locator('.connection-check h2')).toHaveCount(0)
  await page.locator('#check').click()
  await expect(page.locator('#check-result')).toContainText('🇩🇪 DE')
  await expect(page.locator('#check-result')).toHaveCSS('font-size', '16px')
  await expect(page.locator('#check-result')).toHaveCSS('white-space', 'pre-line')
  expect(await page.locator('#check-result').textContent()).toBe(
    'Профиль: Системные настройки\nВыходной IP: 203.0.113.19\nСтрана: 🇩🇪 DE (Германия)\nПротокол: HTTPS\nВремя загрузки: 10 мс'
  )
  const check = await page.locator('#check').boundingBox()
  const profiles = await page.locator('#profiles-title').boundingBox()
  expect(check.y).toBeLessThan(profiles.y)
  await expect(page.locator('#build-version')).toHaveText(
    /MegaProxy \d+\.\d+\.\d+ · (?:[a-f0-9]{8}(?:\+dirty)?|unknown)/
  )
  await expect(page.locator('#rule-url')).toBeHidden()
  await page.locator('#routing-settings > summary').click()
  await expect(page.locator('#routing-settings #rule-url')).toBeVisible()
  await expect(page.locator('#extension-settings-title')).toHaveText('Параметры расширения')
  await expect(page.getByRole('link', { name: 'GitHub', exact: true })).toHaveAttribute(
    'href',
    'https://github.com/andre487/BrowserMegaProxy'
  )
})

test('empty network selector explains its disabled state and actions have spacing', async ({
  page
}) => {
  await page.locator('#network-panel > summary').click()
  await expect(page.locator('#network-tab')).toBeDisabled()
  await expect(page.locator('#network-tab option')).toHaveText('Нет открытых сайтов HTTP или HTTPS')
  await expect(page.locator('#network-add')).toBeDisabled()
  await expect(page.locator('#network-profile')).toHaveCount(0)
})

test('routing source editors are exclusive and tab controls follow browser capabilities', async ({
  page,
  browserName
}) => {
  await page.locator('#routing-settings > summary').click()
  await page.locator('#routing-mode').selectOption('manual')
  await expect(page.locator('#routing-list')).toBeVisible()
  await expect(page.locator('#subscriptions')).toBeHidden()
  await page.locator('#routing-list').fill('saved.example')
  await page.locator('#routing-mode').selectOption('lists')
  await expect(page.locator('#routing-list')).toBeHidden()
  await expect(page.locator('#subscriptions')).toBeVisible()
  await page.locator('#routing-mode').selectOption('manual')
  await expect(page.locator('#routing-list')).toHaveValue('saved.example')
  if (browserName === 'firefox') {
    await page.locator('#routing-mode').selectOption('tabs')
    await expect(page.locator('#routing-list-label')).toHaveText('Сайты для проксирования вкладок')
    await expect(page.locator('#rule-tab-url')).toBeVisible()
  } else {
    await expect(page.locator('#rule-tab-url')).toBeHidden()
  }
})

test('automatic theme responds live to browser media preference and explicit choices override it', async ({
  page,
  browserName
}) => {
  await page.locator('#settings > summary').click()
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(32, 33, 36)')
  // No recognized preference uses the root's dark palette.
  const fallback = await page.evaluate(() => {
    const css = [...document.styleSheets[0].cssRules]
    const root = css.find(rule => rule.selectorText === ':root')
    return root.style.getPropertyValue('--bg').trim()
  })
  expect(fallback).toBe('#202124')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('body')).toHaveCSS(
    'background-color',
    browserName === 'firefox' ? 'rgb(255, 255, 255)' : 'rgb(32, 33, 36)'
  )
  await page.locator('#theme').selectOption('dark')
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(32, 33, 36)')
  await page.reload()
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(32, 33, 36)')
})

test('live catalog discovers new sources, warns about overlap and keeps unavailable selections', async ({
  page
}) => {
  await page.route('https://api.github.com/**', route =>
    route.fulfill({
      json: {
        truncated: false,
        tree: [
          { type: 'blob', path: 'Services/new_service.lst' },
          { type: 'blob', path: 'Services/parent_service.lst' }
        ]
      }
    })
  )
  await page.route('https://raw.githubusercontent.com/**', route =>
    route.fulfill({ body: 'example.com\n' })
  )
  await page.locator('#routing-settings > summary').click()
  await page.locator('#routing-mode').selectOption('lists')
  await page.locator('#update-lists').click()
  await expect(page.locator('#subscription-sources input[value=new_service]')).toBeVisible()
  await page.locator('#subscription-sources input[value=new_service]').check()
  await page.locator('#subscription-sources input[value=parent_service]').check()
  await page.locator('#routing-form').click({ position: { x: 1, y: 1 } })
  await page.evaluate('routingSaves')
  await page.locator('#update-lists').click()
  await expect(page.locator('#lists-warning')).toContainText('уже полностью покрывается')
  await page.route('https://api.github.com/**', route =>
    route.fulfill({
      json: {
        truncated: false,
        tree: [{ type: 'blob', path: 'Services/new_service.lst' }]
      }
    })
  )
  await page.locator('#update-lists').click()
  await expect(page.locator('#subscription-sources input[value=parent_service]')).toBeChecked()
  await expect(page.locator('#lists-warning')).toContainText('сохранена последняя успешная версия')
})

test('popup fits a narrow mobile tab and centers in a wide tab', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto('http://127.0.0.1:8765/popup.html')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
  await expect(page.locator('#open-settings')).toBeInViewport()
  const mobile = await page.locator('body').boundingBox()
  expect(mobile.width).toBeLessThanOrEqual(320)
  await page.setViewportSize({ width: 1200, height: 900 })
  const wide = await page.locator('body').boundingBox()
  expect(wide.width).toBe(380)
  expect(wide.x).toBe(410)
  await page.setViewportSize({ width: 320, height: 320 })
  await expect(page.locator('#open-settings')).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
})

test('WebRTC picker stays anchored, uses the control text size and supports keyboard selection', async ({
  page
}) => {
  await page.locator('#settings > summary').click()
  const customized = await page.evaluate(
    () => CSS.supports('appearance', 'base-select') && matchMedia('(pointer: fine)').matches
  )
  const select = page.locator('#webrtc')
  if (customized) {
    await select.evaluate(element => element.scrollIntoView({ block: 'center' }))
    await select.click()
    const control = await select.boundingBox()
    const option = page.locator('#webrtc option[value=browser]')
    await expect(option).toBeVisible()
    const choice = await option.boundingBox()
    expect(choice.x).toBeGreaterThanOrEqual(control.x - 5)
    expect(choice.x + choice.width).toBeLessThanOrEqual(control.x + control.width + 5)
    expect(control.height).toBeLessThanOrEqual(38)
    expect(choice.y).toBeGreaterThan(control.y + control.height)
    await expect(option).toHaveCSS('font-size', '13px')
    await page.keyboard.press('Escape')
  }
  if (customized) {
    await select.focus()
    await page.keyboard.press('Space')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
  } else {
    await select.selectOption('default')
  }
  await expect(select).toHaveValue('default')
})

test.describe('touch layout', () => {
  test.use({ hasTouch: true, viewport: { width: 320, height: 640 } })

  test('settings dialogs fit the screen and preserve the mobile platform picker', async ({
    page
  }) => {
    await page.locator('#settings > summary').click()
    await expect(page.locator('#webrtc')).toHaveCSS('min-height', '44px')
    expect(
      await page.locator('#webrtc').evaluate(element => getComputedStyle(element).appearance)
    ).not.toBe('base-select')
    await page.locator('#new').click()
    const dialog = await page.locator('#editor').boundingBox()
    expect(dialog.x).toBeGreaterThanOrEqual(0)
    expect(dialog.x + dialog.width).toBeLessThanOrEqual(320)
    expect(dialog.height).toBeLessThanOrEqual(640)
    await expect(page.getByLabel('Хост прокси')).toHaveCSS('min-height', '44px')
    await page.locator('#cancel-profile').click()
    await page.goto('http://127.0.0.1:8765/popup.html')
    await expect(page.locator('#open-settings')).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
  })
})

test('single proxy-mode selector isolates controls and retains inactive settings across reloads', async ({
  page,
  browserName
}) => {
  await page.locator('#new').click()
  await page.getByLabel('Хост прокси').fill('proxy.example')
  await page.getByRole('button', { name: 'Сохранить профиль' }).click()
  await page.locator('#routing-settings > summary').click()
  await expect(page.locator('#routing-source')).toHaveCount(0)
  await page.locator('#routing-mode').selectOption('manual')
  await page.locator('#routing-list').fill('manual.example')
  await page.locator('#routing-mode').selectOption('lists')
  await expect(page.locator('#manual-routing')).toBeHidden()
  await page.locator('#subscription-sources input[value=youtube]').check()
  await page.locator('#lists-auto').uncheck()
  await expect(page.locator('#routing-mode option[value=failover]')).toHaveCount(0)
  await page.locator('#connection-mode').selectOption('proxy')
  await expect(page.locator('#routing-mode')).toHaveValue('lists')
  await page.evaluate('routingSaves')
  await page.reload()
  await expect(page.locator('#connection-mode')).toHaveValue('proxy')
  await page.locator('#routing-settings > summary').click()
  await expect(page.locator('#routing-mode')).toHaveValue('lists')
  await page.locator('#routing-mode').selectOption('manual')
  await expect(page.locator('#routing-list')).toHaveValue('manual.example')
  await page.locator('#routing-form').click({ position: { x: 1, y: 1 } })
  await page.evaluate('routingSaves')
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('testState')))
  expect(saved.browserRouting.strategy).toBe('manual')
  expect(saved.browserRouting.assignments).toEqual([])
  expect(saved.browserRouting.subscriptions.domainSources).toEqual(['youtube'])
  await expect(page.locator('#routing-enabled')).toHaveCount(0)
  await page.locator('#routing-mode').selectOption('all')
  await expect(page.locator('#manual-routing')).toBeHidden()
  await expect(page.locator('#list-routing')).toBeHidden()
  await expect(page.locator('#split-assignments')).toHaveCount(0)
  await page.locator('#routing-form').click({ position: { x: 1, y: 1 } })
  await page.evaluate('routingSaves')
  await page.reload()
  await page.locator('#routing-settings > summary').click()
  await expect(page.locator('#routing-mode')).toHaveValue('all')
  const all = await page.evaluate(() => JSON.parse(localStorage.getItem('testState')))
  expect(all.browserRouting.enabled).toBe(false)
  expect(all.browserRouting.domains).toEqual(['manual.example'])
  await page.locator('#settings > summary').click()
  await expect(page.locator('#sync-passwords').locator('..')).toHaveCSS('border-top-width', '0px')
  if (browserName === 'chromium') {
    expect(await page.locator('body').innerText()).not.toMatch(/split proxy/i)
    await expect(page.locator('#theme option[value=system]')).toHaveCount(0)
  }
})

test('profile order persists after pointer dragging and canceled dragging restores it', async ({
  page
}) => {
  await page.evaluate(() => {
    const animate = Element.prototype.animate
    globalThis.profileAnimations = []
    Element.prototype.animate = function (...args) {
      if (this.classList.contains('profile')) {
        globalThis.profileAnimations.push(args[1].duration)
      }
      return animate.apply(this, args)
    }
  })
  for (const name of ['First', 'Second', 'Third']) {
    await page.locator('#new').click()
    await page.getByLabel('Название').fill(name)
    await page.getByLabel('Хост прокси').fill('proxy.example')
    await page.getByRole('button', { name: 'Сохранить профиль' }).click()
  }
  const handle = await page.locator('.profile-drag').last().boundingBox()
  const first = await page.locator('.profile').first().boundingBox()
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(first.x + 25, first.y + 5, { steps: 10 })
  await expect(page.locator('.profile').first()).toContainText('Third')
  expect(await page.evaluate(() => globalThis.profileAnimations)).toContain(180)
  await page.mouse.up()
  await expect
    .poll(async () =>
      page.evaluate(() => JSON.parse(localStorage.getItem('testState')).profiles.map(p => p.name))
    )
    .toEqual(['Third', 'First', 'Second'])
  await page.reload()
  await expect(page.locator('.profile').first()).toContainText('Third')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(() => {
    globalThis.profileAnimations = []
  })
  const start = await page.locator('.profile-drag').first().boundingBox()
  const end = await page.locator('.profile').last().boundingBox()
  await page.mouse.move(start.x + 20, start.y + 20)
  await page.mouse.down()
  await page.mouse.move(end.x + 25, end.y + end.height - 5, { steps: 10 })
  await expect(page.locator('.profile').last()).toContainText('Third')
  expect(await page.evaluate(() => globalThis.profileAnimations)).toEqual([])
  await page.locator('.profile-drag').last().dispatchEvent('pointercancel')
  await page.mouse.up()
  await expect(page.locator('.profile').first()).toContainText('Third')
})

test('touch dragging moves a profile on narrow screens', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Real touch movement uses Chromium CDP')
  await page.setViewportSize({ width: 320, height: 700 })
  for (const name of ['First', 'Second']) {
    await page.locator('#new').click()
    await page.getByLabel('Название').fill(name)
    await page.getByLabel('Хост прокси').fill('proxy.example')
    await page.getByRole('button', { name: 'Сохранить профиль' }).click()
  }
  const session = await context.newCDPSession(page)
  const start = await page.locator('.profile-drag').last().boundingBox()
  const end = await page.locator('.profile').first().boundingBox()
  await expect(page.locator('.profile-drag').first()).toHaveCSS('touch-action', 'none')
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: start.x + 20, y: start.y + 20 }]
  })
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: end.x + 20, y: end.y + 5 }]
  })
  await expect(page.locator('.profile').first()).toContainText('Second')
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await expect
    .poll(async () =>
      page.evaluate(() => JSON.parse(localStorage.getItem('testState')).profiles[0].name)
    )
    .toBe('Second')
})

test('browser action popup uses content dimensions rather than its initial tiny viewport', async ({
  page
}) => {
  await page.addInitScript(() => {
    globalThis.chrome.tabs.getCurrent = async () => undefined
  })
  await page.setViewportSize({ width: 155, height: 170 })
  await page.goto('http://127.0.0.1:8765/popup.html')
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'popup')
  await expect(page.locator('body')).toHaveCSS('width', '380px')
  await expect(page.locator('main')).toHaveCSS('max-height', '600px')
})

test('Android browser action popup fits the mobile viewport and keeps settings accessible', async ({
  page
}) => {
  await page.addInitScript(() => {
    globalThis.chrome.tabs.getCurrent = async () => undefined
    globalThis.chrome.runtime.getPlatformInfo = async () => ({ os: 'android' })
  })
  for (const width of [320, 360]) {
    await page.setViewportSize({ width, height: 700 })
    await page.goto('http://127.0.0.1:8765/popup.html')
    await expect(page.locator('html')).toHaveAttribute('data-surface', 'tab')
    const layout = await page.evaluate(() => ({
      content: document.documentElement.scrollWidth,
      viewport: innerWidth,
      settingsRight: document.querySelector('#open-settings').getBoundingClientRect().right
    }))
    expect(layout.content).toBeLessThanOrEqual(layout.viewport)
    expect(layout.settingsRight).toBeLessThanOrEqual(layout.viewport)
  }
})

test('Android popup content is not constrained by Vivaldi initial tiny viewport', async ({
  page
}) => {
  await page.addInitScript(() => {
    globalThis.chrome.tabs.getCurrent = async () => ({ id: 1 })
    globalThis.chrome.runtime.getPlatformInfo = async () => ({ os: 'android' })
  })
  await page.setViewportSize({ width: 320, height: 74 })
  await page.goto('http://127.0.0.1:8765/popup.html')
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'tab')
  await expect(page.locator('main')).toHaveCSS('max-height', '600px')
  expect(await page.locator('.popup-content').evaluate(e => e.clientHeight)).toBeGreaterThan(200)
})

test('routing autosaves consecutive changes without losing later edits and recovers after errors', async ({
  page
}) => {
  await page.evaluate(() => {
    const original = chrome.runtime.sendMessage
    chrome.runtime.sendMessage = async message => {
      if (message.command === 'routing') {
        await new Promise(resolve => setTimeout(resolve, 100))
        if (message.routing.domains.includes('bad')) {
          return { ok: false, error: 'errorRoutingDomain' }
        }
      }
      return original(message)
    }
  })
  await page.locator('#routing-settings > summary').click()
  await expect(page.locator('#routing-form button[type=submit]')).toHaveCount(0)
  await page.locator('#routing-mode').selectOption('manual')
  await page.locator('#routing-list').fill('first.example')
  await page.locator('#routing-list').blur()
  await page.locator('#routing-list').fill('second.example')
  await page.locator('#routing-list').blur()
  await page.evaluate('routingSaves')
  await expect(page.locator('#routing-list')).toHaveValue('second.example')
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('testState')).browserRouting.domains)
  ).toEqual(['second.example'])
  await page.locator('#routing-list').fill('bad')
  await page.locator('#routing-list').blur()
  await page.evaluate('routingSaves')
  await expect(page.locator('#notice')).not.toBeEmpty()
  await expect(page.locator('#routing-list')).toHaveValue('bad')
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('testState')).browserRouting.domains)
  ).toEqual(['second.example'])
  await page.locator('#routing-list').fill('fixed.example')
  await page.locator('#routing-list').blur()
  await page.evaluate('routingSaves')
  await expect(page.locator('#notice')).toBeEmpty()
  await page.reload()
  await page.locator('#routing-settings > summary').click()
  await expect(page.locator('#routing-list')).toHaveValue('fixed.example')
})

test('profiles can be selected in options and popup and the selected button follows activation', async ({
  page
}) => {
  for (const name of ['First', 'Second']) {
    await page.locator('#new').click()
    await page.getByLabel('Название').fill(name)
    await page.getByLabel('Хост прокси').fill('proxy.example')
    await page.getByRole('button', { name: 'Сохранить профиль' }).click()
  }
  const first = page
    .locator('.profile')
    .filter({ has: page.locator('strong', { hasText: 'First' }) })
  const second = page
    .locator('.profile')
    .filter({ has: page.locator('strong', { hasText: 'Second' }) })
  await first.getByRole('button', { name: 'Выбрать', exact: true }).click()
  await expect(first.getByRole('button', { name: 'Выбран', exact: true })).toBeDisabled()
  await expect(first.getByRole('button', { name: 'Изменить', exact: true })).toBeEnabled()
  await expect(second.getByRole('button', { name: 'Выбрать', exact: true })).toBeEnabled()
  await second.getByRole('button', { name: 'Выбрать', exact: true }).click()
  await expect(second.getByRole('button', { name: 'Выбран', exact: true })).toBeDisabled()
  await expect(first.getByRole('button', { name: 'Выбрать', exact: true })).toBeEnabled()
  await page.reload()
  await expect(second.getByRole('button', { name: 'Выбран', exact: true })).toBeDisabled()
  await page.setViewportSize({ width: 320, height: 700 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
  await expect(second.getByRole('button', { name: 'Выбран', exact: true })).toBeInViewport()
  await page.goto('http://127.0.0.1:8765/popup.html')
  await expect(second.getByRole('button', { name: 'Выбран', exact: true })).toBeDisabled()
  await first.getByRole('button', { name: 'Выбрать', exact: true }).click()
  await expect(first.getByRole('button', { name: 'Выбран', exact: true })).toBeDisabled()
  await expect(second.getByRole('button', { name: 'Выбрать', exact: true })).toBeEnabled()
  await page.locator('#connection-mode').selectOption('direct')
  await expect(page.getByRole('button', { name: 'Выбран', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Выбрать', exact: true })).toHaveCount(2)
  await page.locator('#open-settings').click()
  await page.locator('#settings > summary').click()
  await page.locator('#language').selectOption('en')
  await first.getByRole('button', { name: 'Select', exact: true }).click()
  await expect(first.getByRole('button', { name: 'Selected', exact: true })).toBeDisabled()
})

test('popup shows the active profile color only in proxy mode', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem(
      'testState',
      JSON.stringify({
        language: 'en',
        connectionMode: 'proxy',
        activeId: 'a',
        profiles: [
          { id: 'a', name: 'Red', type: 'HTTP', host: 'a.example', port: 8080, color: 0 },
          { id: 'b', name: 'Blue', type: 'HTTP', host: 'b.example', port: 8080, color: 5 }
        ]
      })
    )
  })
  await page.goto('http://127.0.0.1:8765/popup.html')
  const heading = page.locator('#connection')
  const marker = () =>
    heading.evaluate(element => {
      const style = getComputedStyle(element, '::before')
      return { color: style.backgroundColor, display: style.display }
    })
  await expect(heading).toHaveText('Profile: Red')
  expect(await marker()).toEqual({ color: 'rgb(244, 67, 54)', display: 'inline-block' })
  await page
    .locator('[data-profile-id="b"]')
    .getByRole('button', { name: 'Select', exact: true })
    .click()
  await expect(heading).toHaveText('Profile: Blue')
  expect(await marker()).toEqual({ color: 'rgb(33, 150, 243)', display: 'inline-block' })
  for (const mode of ['direct', 'system']) {
    await page.locator('#connection-mode').selectOption(mode)
    await expect(heading).not.toHaveClass(/has-profile/)
  }
  await page.locator('#connection-mode').selectOption('proxy')
  await expect(heading).toHaveClass(/has-profile/)
  expect(await marker()).toEqual({ color: 'rgb(33, 150, 243)', display: 'inline-block' })
})

test('connection mode stays synchronized between popup and multiple settings pages', async ({
  page,
  context
}) => {
  await page.locator('#new').click()
  await page.getByLabel('Хост прокси').fill('proxy.example')
  await page.getByRole('button', { name: 'Сохранить профиль' }).click()
  await page.getByRole('button', { name: 'Выбрать', exact: true }).click()
  const second = await context.newPage()
  await second.goto('http://127.0.0.1:8765/options.html')
  const popup = await context.newPage()
  await popup.goto('http://127.0.0.1:8765/popup.html')
  for (const [source, mode] of [
    [popup, 'direct'],
    [second, 'system'],
    [popup, 'proxy']
  ]) {
    await source.locator('#connection-mode').selectOption(mode)
    for (const view of [page, second, popup]) {
      await expect(view.locator('#connection-mode')).toHaveValue(mode)
    }
  }
  await second.reload()
  await expect(second.locator('#connection-mode')).toHaveValue('proxy')
})

test('connection results localize country names and preserve missing-country output', async ({
  page
}) => {
  await page.locator('#check').click()
  await expect(page.locator('#check-result')).toContainText('🇩🇪 DE (Германия)')
  await page.locator('#settings > summary').click()
  await page.locator('#language').selectOption('en')
  await expect(page.locator('#check-result')).toContainText('🇩🇪 DE (Germany)')
  await page.evaluate('connectionCheck.countryCode = ""; renderCheck()')
  await expect(page.locator('#check-result')).toContainText('Country: —')
  await expect(page.locator('#check-result')).not.toContainText('undefined')
})

test('routing catalog refresh is requested on expansion rather than opening the settings page', async ({
  page
}) => {
  const requests = () =>
    page.evaluate(
      () => (globalThis.testCommands || []).filter(command => command === 'routingOpened').length
    )
  expect(await requests()).toBe(0)
  await page.locator('#routing-settings > summary').click()
  await expect.poll(requests).toBe(1)
  await page.locator('#routing-settings > summary').click()
  expect(await requests()).toBe(1)
  await page.locator('#routing-settings > summary').click()
  await expect.poll(requests).toBe(2)
})

test('routing sections have one title and network actions follow the selected mode', async ({
  page,
  browserName
}) => {
  await page.locator('#routing-settings > summary').click()
  await expect(page.locator('#routing-settings > summary')).toHaveText('Режим маршрутизации')
  await expect(page.locator('#routing-mode-label')).toHaveCount(0)
  await page.locator('#network-panel > summary').click()
  for (const mode of ['all', 'manual', 'lists', ...(browserName === 'firefox' ? ['tabs'] : [])]) {
    await page.locator('#routing-mode').selectOption(mode)
    await page.evaluate('routingSaves')
    if (['manual', 'tabs'].includes(mode)) {
      await expect(page.locator('#network-add')).toBeVisible()
    } else {
      await expect(page.locator('#network-add')).toBeHidden()
    }
  }
})

test('UI explains transport failures and transferred background errors with their operation', async ({
  page
}) => {
  await page.goto('http://127.0.0.1:8765/popup.html')
  await expect(page.locator('body')).toBeVisible()
  await page.evaluate(() => {
    chrome.runtime.sendMessage = async () => {
      throw new TypeError('Failed to fetch')
    }
  })
  await page.locator('#check').click()
  await expect(page.locator('#check-result')).toContainText('Проверка подключения:')
  await expect(page.locator('#check-result')).toContainText(
    'Браузер не смог выполнить сетевой запрос'
  )
  await expect(page.locator('#check-result')).toHaveClass('error')
  await expect(page.locator('#notice')).toBeEmpty()
  await page.evaluate(() => {
    chrome.runtime.sendMessage = async () => ({
      ok: false,
      error: 'errorIcon',
      errorDetails: {
        operation: 'toolbarIcon',
        code: 'errorIcon',
        reason: 'errorNetwork',
        resource: 'toolbar32.png'
      }
    })
  })
  await page.locator('#check').click()
  await expect(page.locator('#check-result')).toContainText(
    'Загрузка иконки тулбара (toolbar32.png):'
  )
  await expect(page.locator('#check-result')).not.toContainText('Failed to fetch')
  await expect(page.locator('#notice')).toBeEmpty()
})

test('authentication page keeps rejected edits and closes after credentials are saved', async ({
  page
}) => {
  await page.addInitScript(() => {
    globalThis.authPhase = 'waiting'
    globalThis.authMessages = []
    globalThis.authClosedTabs = []
    chrome.tabs.getCurrent = async () => ({ id: 7 })
    chrome.tabs.remove = async id => globalThis.authClosedTabs.push(id)
    chrome.runtime.sendMessage = async message => {
      globalThis.authMessages.push(message)
      if (message.command === 'authSubmit') {
        globalThis.authPhase = 'checking'
      }
      return {
        ok: true,
        auth: {
          phase: globalThis.authPhase,
          name: 'Test proxy',
          host: 'proxy.example',
          port: 443,
          username: 'old-user',
          language: 'ru',
          theme: 'dark',
          errorDetails:
            globalThis.authPhase === 'rejected'
              ? { code: 'errorAuthRejected', operation: 'authentication' }
              : undefined
        }
      }
    }
  })
  await page.goto('http://127.0.0.1:8765/auth.html?id=test')
  await expect(page.locator('body')).toBeVisible()
  await expect(page.locator('#auth-profile')).toHaveText('Test proxy')
  await expect(page.locator('#auth-password')).toBeFocused()
  expect(await page.evaluate(() => globalThis.authClosedTabs)).toEqual([])
  await page.locator('#auth-username').fill('new-user')
  await page.locator('#auth-password').fill('private-secret')
  await page.locator('#auth-submit').click()
  await expect(page.locator('#auth-submit')).toBeDisabled()
  await expect(page.locator('#notice')).toContainText('Ожидаем подтверждения')
  await page.evaluate(() => {
    globalThis.authPhase = 'rejected'
  })
  await expect(page.locator('#notice')).toContainText('Прокси отклонил эти данные')
  await expect(page.locator('#auth-username')).toHaveValue('new-user')
  await expect(page.locator('#auth-password')).toHaveValue('private-secret')
  await expect(page.locator('#auth-password')).toBeFocused()
  expect(await page.evaluate(() => globalThis.authClosedTabs)).toEqual([])
  await page.evaluate(() => {
    globalThis.authPhase = 'saved'
  })
  await expect(page.locator('#notice')).toHaveText('Данные приняты и сохранены.')
  await expect(page.locator('#auth-password')).toHaveValue('')
  expect(await page.evaluate(() => globalThis.authClosedTabs)).toEqual([7])
  await expect(page.locator('#auth-cancel')).toHaveText('Закрыть')
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('private-secret')
})

test('SOCKS5 credentials are disabled with an explanation only in Chromium', async ({
  page,
  browserName
}) => {
  await page.locator('#new').click()
  const form = page.locator('#profile-form')
  await form.locator('[name=host]').fill('socks.example')
  await form.locator('[name=username]').fill('user')
  await form.locator('[name=password]').fill('secret')
  await form.locator('[name=type]').selectOption('socks5')
  const username = form.locator('[name=username]')
  const password = form.locator('[name=password]')
  if (browserName === 'chromium') {
    await expect(username).toBeDisabled()
    await expect(password).toBeDisabled()
    await expect(page.locator('#socks-auth-hint')).toContainText(
      'не поддерживает SOCKS5 с логином и паролем'
    )
  } else {
    await expect(username).toBeEnabled()
    await expect(password).toBeEnabled()
    await expect(page.locator('#socks-auth-hint')).toBeHidden()
  }
  await expect(page.locator('#knock-hint')).toContainText('knock не нужен')
  await form.locator('[name=type]').selectOption('https')
  await expect(username).toBeEnabled()
  await expect(password).toBeEnabled()
  await expect(username).toHaveValue('user')
  await expect(page.locator('#socks-auth-hint')).toBeHidden()
  await page.getByRole('button', { name: 'Сохранить профиль' }).click()
  await expect(page.locator('.profile')).toHaveCount(1)
  await page.getByRole('button', { name: 'Изменить', exact: true }).click()
  await form.locator('[name=type]').selectOption('socks5')
  await page.getByRole('button', { name: 'Сохранить профиль' }).click()
  await expect(page.locator('.profile')).toHaveCount(1)
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('testState')).profiles[0])
  expect(saved.type).toBe('socks5')
  expect(saved.username).toBe(browserName === 'chromium' ? '' : 'user')
  expect(saved.password).toBe(browserName === 'chromium' ? '' : 'secret')
})

test('MASQUE editor is Firefox-only and preserves its path template', async ({
  page,
  browserName
}) => {
  await page.locator('#new').click()
  const form = page.locator('#profile-form')
  if (browserName === 'chromium') {
    await expect(form.locator('option[value=masque]')).toHaveCount(0)
    await expect(page.locator('#masque-setting')).toBeHidden()
    return
  }
  await expect(page.locator('#masque-enabled')).not.toBeChecked()
  await expect(form.locator('option[value=masque]')).toHaveAttribute('disabled', '')
  await page.locator('#cancel-profile').click()
  await page.locator('#settings').evaluate(element => {
    element.open = true
  })
  await page.locator('#masque-enabled').check()
  await page.reload()
  await expect(page.locator('#masque-enabled')).toBeChecked()
  await page.locator('#new').click()
  await expect(form.locator('option[value=masque]')).not.toHaveAttribute('disabled', '')
  await form.locator('[name=type]').selectOption('masque')
  await form.locator('[name=host]').fill('proxy.example')
  await expect(form.locator('[name=knockHost]')).toBeDisabled()
  await expect(form.locator('[name=username]')).toBeDisabled()
  await expect(page.locator('#masque-hint')).toContainText('Firefox 146+')
  await form.locator('[name=masqueTemplate]').fill('/custom/{target_host}/{target_port}/')
  await page.getByRole('button', { name: 'Сохранить профиль' }).click()
  await expect(page.locator('.profile')).toHaveCount(1)
  await page.getByRole('button', { name: 'Изменить', exact: true }).click()
  await expect(form.locator('[name=type]')).toHaveValue('masque')
  await expect(form.locator('[name=masqueTemplate]')).toHaveValue(
    '/custom/{target_host}/{target_port}/'
  )
  await form.locator('[name=type]').selectOption('https')
  await expect(page.locator('#masque-template-field')).toBeHidden()
  await expect(form.locator('[name=knockHost]')).toBeEnabled()
})

test('Firefox warns when disabled MASQUE profiles are imported from a file', async ({
  page,
  browserName
}) => {
  test.skip(browserName !== 'firefox')
  await page.locator('#import').setInputFiles({
    name: 'masque.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        profiles: [
          { name: 'Experimental', proxy: { type: 'MASQUE', host: 'proxy.example', port: 443 } }
        ]
      })
    )
  })
  await expect(page.locator('#import-warnings')).toContainText(
    'MASQUE отключён: профили MASQUE пропущены.'
  )
  await page.locator('#apply-import').click()
  await expect(page.locator('.profile')).toHaveCount(0)
})

for (const scenario of ['add-profile', 'import-config']) {
  test(`empty popup opens the ${scenario} settings scenario and hides actions after adding a profile`, async ({
    page
  }) => {
    await page.addInitScript(() => {
      globalThis.chrome.tabs.create = async ({ url }) => {
        location.href = url
        return { id: 1 }
      }
    })
    await page.goto('http://127.0.0.1:8765/popup.html')
    await expect(page.locator('#empty')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Добавить профиль', exact: true })).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Импортировать конфиг', exact: true })
    ).toBeVisible()
    await page.locator(`#${scenario}`).click()
    if (scenario === 'add-profile') {
      await expect(page.locator('#editor')).toBeVisible()
      await expect(page.locator('[name=name]')).toBeFocused()
      await page.getByLabel('Хост прокси').fill('proxy.example')
      await page.getByRole('button', { name: 'Сохранить профиль' }).click()
    } else {
      await expect(page.locator('#import-start')).toBeVisible()
      const chooser = page.waitForEvent('filechooser')
      await page.locator('#import-file').click()
      await (
        await chooser
      ).setFiles({
        name: 'proxy.json',
        mimeType: 'application/json',
        buffer: Buffer.from(
          JSON.stringify({
            profiles: [
              { name: 'Imported', proxy: { type: 'HTTPS', host: 'proxy.example', port: 443 } }
            ]
          })
        )
      })
      await expect(page.locator('#import-review')).toBeVisible()
      await page.locator('#apply-import').click()
    }
    await expect(page.locator('.profile')).toHaveCount(1)
    await page.reload()
    await expect(page.locator('dialog[open]')).toHaveCount(0)
    await page.goto('http://127.0.0.1:8765/popup.html')
    await expect(page.locator('.profile')).toHaveCount(1)
    await expect(page.locator('#empty')).toBeHidden()
    await expect(page.locator('#add-profile')).toBeHidden()
    await expect(page.locator('#import-config')).toBeHidden()
    await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem('testState'))
      state.profiles = []
      state.activeId = null
      const newValue = JSON.stringify(state)
      localStorage.setItem('testState', newValue)
      window.dispatchEvent(new StorageEvent('storage', { key: 'testState', newValue }))
    })
    await expect(page.locator('#empty')).toBeVisible()
  })
}

test('popup import scenario opens the existing URL import dialog', async ({ page }) => {
  await page.goto('http://127.0.0.1:8765/popup.html')
  await page.goto('http://127.0.0.1:8765/options.html#import-config')
  await expect(page.locator('#import-start')).toBeVisible()
  await page.locator('#import-from-url').click()
  await expect(page.locator('#import-start')).not.toBeVisible()
  await expect(page.locator('#url-import')).toBeVisible()
  await expect(page.locator('#config-url')).toBeFocused()
})
