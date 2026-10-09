import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    globalThis.chrome = {
      runtime: { getURL: path => new URL(path, location.href).href },
      i18n: { getUILanguage: () => 'ru-RU' },
      storage: {
        local: { get: async () => ({ state: { language: 'ru', theme: 'dark' } }) },
        onChanged: { addListener: () => {} }
      }
    }
  })
  await page.goto('http://127.0.0.1:8765/log.html')
  await expect(page.locator('body')).toBeVisible()
})

test('log persists, bounds its volume, coalesces repetitions, sanitizes and exports retained entries', async ({
  page
}) => {
  await page.evaluate(async () => {
    const log = new globalThis.MegaDiagnosticLog()
    for (let i = 0; i < 20; i++) {
      log.write('request_failed', {
        code: 'NS_ERROR_CONNECTION_REFUSED',
        username: 'private-user',
        password: 'private-secret',
        url: 'https://private.example/path'
      })
    }
    log.write('operation_failed', { code: 'password=private-secret https://private.example/' })
    await log.flush()
  })
  await expect(page.locator('#log-output')).toContainText('×20')
  await expect(page.locator('#log-output')).not.toContainText('private')
  await page.reload()
  await expect(page.locator('#log-output')).toContainText('×20')
  const unchanged = await page.evaluate(async () => {
    const log = new globalThis.MegaDiagnosticLog()
    const first = await log.read()
    return (await log.read(first.meta.revision)).rows === undefined
  })
  expect(unchanged).toBe(true)
  await page.locator('#log-limit').fill('11')
  await page.locator('#log-limit').dispatchEvent('change')
  await expect(page.locator('#log-status')).toContainText('от 1 до 10 MiB')
  expect(
    await page.evaluate(async () => (await new globalThis.MegaDiagnosticLog().read()).meta.limit)
  ).toBe(3 * 1024 * 1024)
  await page.locator('#log-limit').fill('10')
  await page.locator('#log-limit').dispatchEvent('change')
  await expect
    .poll(() =>
      page.evaluate(async () => (await new globalThis.MegaDiagnosticLog().read()).meta.limit)
    )
    .toBe(10 * 1024 * 1024)
  await page.locator('#log-limit').fill('1')
  await page.locator('#log-limit').dispatchEvent('change')
  const retained = await page.evaluate(async () => {
    const log = new globalThis.MegaDiagnosticLog()
    for (let batch = 0; batch < 70; batch++) {
      for (let i = 0; i < 256; i++) {
        log.write('request_failed', {
          profile: batch * 256 + i,
          code: 'NS_ERROR_CONNECTION_REFUSED',
          type: 'main_frame'
        })
      }
      await log.flush()
    }
    return log.read(-1, Infinity)
  })
  expect(retained.meta.bytes).toBeLessThanOrEqual(1024 * 1024)
  expect(retained.rows.map(row => row.text).join('')).not.toContain('×20')
  expect(retained.rows.at(-1).text).toContain('17919')
  const download = page.waitForEvent('download')
  await page.locator('#log-export').click()
  const file = await download
  const exported = await readFile(await file.path(), 'utf8')
  expect(exported).toContain('17919')
  expect(exported).not.toContain('private-secret')
  await page.locator('#log-clear').click()
  await expect(page.locator('#log-output')).toHaveText('')
  await page.reload()
  await expect(page.locator('#log-output')).toHaveText('')
  await expect(page.locator('#log-limit')).toHaveValue('1')
})

test('live log follows the bottom, preserves manual scrolling and resumes when the user returns to the bottom', async ({
  page
}) => {
  await page.setViewportSize({ width: 320, height: 640 })
  const append = async start =>
    page.evaluate(async start => {
      const log = new globalThis.MegaDiagnosticLog()
      for (let i = start; i < start + 80; i++) {
        log.write('settings_changed', { profile: i, mode: 'proxy' })
      }
      await log.flush()
    }, start)
  const distance = () =>
    page
      .locator('#log-output')
      .evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)
  await append(0)
  await expect(page.locator('#log-output')).toContainText('"profile":79')
  await expect.poll(distance).toBeLessThan(5)
  await page.locator('#log-output').evaluate(node => {
    node.scrollTop = 200
    node.dispatchEvent(new Event('scroll'))
  })
  const top = await page.locator('#log-output').evaluate(node => node.scrollTop)
  await append(80)
  await expect(page.locator('#log-output')).toContainText('"profile":159')
  expect(await page.locator('#log-output').evaluate(node => node.scrollTop)).toBe(top)
  await page.locator('#log-output').evaluate(node => {
    node.scrollTop = node.scrollHeight
    node.dispatchEvent(new Event('scroll'))
  })
  await append(160)
  await expect(page.locator('#log-output')).toContainText('"profile":239')
  await expect.poll(distance).toBeLessThan(5)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(640)
  await expect(page.locator('#log-clear')).toBeInViewport()
  const input = await page.locator('#log-limit').boundingBox()
  const actions = await page.locator('.log-actions').boundingBox()
  expect(actions.y - input.y - input.height).toBeGreaterThanOrEqual(24)
  await page.setViewportSize({ width: 1200, height: 800 })
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(800)
  const wideInput = await page.locator('#log-limit').boundingBox()
  const wideActions = await page.locator('.log-actions').boundingBox()
  expect(wideActions.y - wideInput.y - wideInput.height).toBeGreaterThanOrEqual(24)
})

test('storage failures are visible and logger can recover without interrupting the page', async ({
  page
}) => {
  const recovered = await page.evaluate(async () => {
    const log = new globalThis.MegaDiagnosticLog()
    const original = log.transaction.bind(log)
    log.transaction = async () => {
      throw new Error('Storage unavailable')
    }
    log.write('request_failed', { code: 'NS_ERROR_CONNECTION_REFUSED' })
    await log.flush().catch(() => {})
    log.transaction = original
    log.write('background_started')
    await log.flush()
    return (await log.read()).rows.map(row => row.text).join('')
  })
  expect(recovered).toContain('background_started')
})

test('log stores safe error context and exposes specific storage failures', async ({ page }) => {
  await page.evaluate(async () => {
    const log = new globalThis.MegaDiagnosticLog()
    log.write('operation_failed', {
      operation: 'fetchConfig',
      code: 'errorConfigDownload',
      reason: 'TimeoutError',
      status: 503,
      responseBody: 'upstream unavailable; password=private-password; https://private.example/',
      resource: 'private-secret',
      password: 'private-password',
      url: 'https://private.example/'
    })
    await log.flush()
  })
  await expect(page.locator('#log-output')).toContainText('"operation":"fetchConfig"')
  await expect(page.locator('#log-output')).toContainText('"reason":"TimeoutError"')
  await expect(page.locator('#log-output')).toContainText('"status":503')
  await expect(page.locator('#log-output')).toContainText('upstream unavailable')
  await expect(page.locator('#log-output')).not.toContainText('private')
  await page.evaluate(() => {
    globalThis.MegaDiagnosticLog.prototype.configure = async () => {
      throw new DOMException('private-password', 'QuotaExceededError')
    }
  })
  await page.locator('#log-clear').click()
  await expect(page.locator('#log-status')).toContainText('Очистка журнала диагностики:')
  await expect(page.locator('#log-status')).toContainText('Превышен лимит хранилища браузера')
  await expect(page.locator('#log-status')).not.toContainText('private')
})
