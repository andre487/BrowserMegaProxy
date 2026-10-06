import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { build, launchBrowser, selectBrowser } from '../scripts/start.mjs'

test('development launcher reloads current code and retains the dedicated Chrome profile', async ({
  browserName
}) => {
  test.skip(browserName !== 'chromium', 'The Chrome launcher is checked once')
  expect(selectBrowser(['--firefox'], {})).toBe('firefox')
  expect(selectBrowser([], { npm_config_firefox: 'true' })).toBe('firefox')
  expect(selectBrowser(['--chrome', '--watch'], {})).toBe('chrome')
  expect(() => selectBrowser(['--chrome', '--firefox'], {})).toThrow('Choose one browser')

  await build()

  const profileDir = await mkdtemp(path.join(tmpdir(), 'mega-launcher-'))
  const file = 'dist/chromium/popup.html'
  const original = await readFile(file, 'utf8')
  let session

  try {
    await writeFile(file, original.replace('<body hidden', '<body hidden data-launch="initial"'))
    try {
      session = await launchBrowser('chrome', { headless: true, profileDir })
    } catch (error) {
      test.skip(
        error.message.includes("Chromium distribution 'chrome' is not found"),
        'Install Google Chrome to check the development launcher'
      )
      throw error
    }

    let page = session.context.pages()[0]
    await expect(page.locator('body')).toBeVisible()
    await expect(page.locator('body')).toHaveAttribute('data-launch', 'initial')
    expect(page.viewportSize()).toBeNull()
    const popupURL = page.url()
    await page.goto(popupURL.replace('popup.html', 'options.html'))
    await page.evaluate(() =>
      globalThis.chrome.runtime.sendMessage({
        command: 'save',
        profile: {
          name: 'A very long profile name that should wrap inside a narrow window',
          type: 'HTTPS',
          host: 'very-long-proxy-host.example.com',
          port: 443
        }
      })
    )
    await expect(page.locator('.profile')).toHaveCount(1)
    const pageCDP = await session.context.newCDPSession(page)
    const { targetInfo } = await pageCDP.send('Target.getTargetInfo')
    const browserCDP = await session.context.browser().newBrowserCDPSession()
    const { windowId } = await browserCDP.send('Browser.getWindowForTarget', {
      targetId: targetInfo.targetId
    })
    await browserCDP.send('Browser.setWindowBounds', {
      windowId,
      bounds: { width: 560, height: 700 }
    })
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThanOrEqual(560)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
    const main = await page.locator('main').boundingBox()
    expect(main.x).toBeGreaterThanOrEqual(0)
    expect(main.x + main.width).toBeLessThanOrEqual(560)
    await pageCDP.detach()
    await browserCDP.detach()
    await page.goto(popupURL)

    await page.evaluate(() =>
      globalThis.chrome.runtime.sendMessage({ command: 'language', language: 'en' })
    )
    await writeFile(file, original.replace('<body hidden', '<body hidden data-launch="reloaded"'))
    await session.reload()
    page = session.context.pages().find(page => page.url().startsWith('chrome-extension://'))
    await expect(page.locator('body')).toHaveAttribute('data-launch', 'reloaded')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await session.close()

    await writeFile(file, original.replace('<body hidden', '<body hidden data-launch="fresh"'))
    session = await launchBrowser('chrome', { headless: true, profileDir })
    page = session.context.pages()[0]
    await expect(page.locator('body')).toBeVisible()
    await expect(page.locator('body')).toHaveAttribute('data-launch', 'fresh')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  } finally {
    await session?.close()
    await writeFile(file, original)
    await rm(profileDir, { recursive: true, force: true })
  }
})
