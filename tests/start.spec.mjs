import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { expect, firefox, test } from '@playwright/test'
import { build, launchBrowser, selectBrowser } from '../scripts/start.mjs'

test('development launcher installs and reloads the Firefox extension on a persistent profile', async ({
  browserName
}) => {
  test.skip(browserName !== 'firefox', 'The Firefox launcher is checked once')
  const profileDir = await mkdtemp(path.join(tmpdir(), 'mega-firefox-launcher-'))
  let session

  try {
    try {
      session = await launchBrowser('firefox', {
        headless: true,
        profileDir,
        executablePath: firefox.executablePath()
      })
    } catch (error) {
      test.skip(
        error.code === 'ENOENT' || error.message.startsWith('Install Firefox'),
        'Install Firefox to check the development launcher'
      )
      throw error
    }

    await session.reload()
    await session.close()
    expect(await session.closed).toEqual({ code: 0, signal: null })
    session = await launchBrowser('firefox', {
      headless: true,
      profileDir,
      executablePath: firefox.executablePath()
    })
    await session.reload()
  } finally {
    await session?.close()
    await session?.closed
    await rm(profileDir, { recursive: true, force: true })
  }
})

test('Ctrl+C exits the development launcher and browser cleanly', async ({ browserName }) => {
  test.setTimeout(90000)
  test.skip(process.platform === 'win32', 'Terminal process-group signals are tested on Unix')
  const profileDir = await mkdtemp(path.join(tmpdir(), 'mega-launcher-interrupt-'))
  const options = {
    browser: browserName === 'chromium' ? 'chrome' : 'firefox',
    headless: true,
    profileDir,
    ...(browserName === 'firefox' ? { executablePath: firefox.executablePath() } : {})
  }
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { start } from './scripts/start.mjs'; await start(${JSON.stringify(options)})`
    ],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DEBUG: 'pw:api,pw:browser' }
    }
  )
  let output = ''
  child.stdout.on('data', chunk => {
    output += chunk
  })
  child.stderr.on('data', chunk => {
    output += chunk
  })
  const exited = new Promise(resolve =>
    child.once('exit', (code, signal) => resolve({ code, signal }))
  )
  try {
    await expect
      .poll(
        () => {
          if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`Launcher exited before readiness: ${output}`)
          }
          return output
        },
        { timeout: 60000 }
      )
      .toContain('Extension loaded.')
    process.kill(-child.pid, 'SIGINT')
    expect(await exited).toEqual({ code: 0, signal: null })
    expect(output).not.toContain('Unable to start:')
    expect(output).not.toContain('UnhandledPromiseRejection')
    if (browserName === 'chromium') {
      const preferences = JSON.parse(await readFile(`${profileDir}/Default/Preferences`, 'utf8'))
      expect(preferences.profile.exit_type).toBe('Normal')
    } else {
      const checkpoints = JSON.parse(
        await readFile(`${profileDir}/sessionCheckpoints.json`, 'utf8')
      )
      expect(checkpoints['profile-before-change']).toBe(true)
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await exited
    }
    await rm(profileDir, { recursive: true, force: true })
  }
})

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
  const backgroundFile = 'dist/chromium/background.js'
  const backgroundOriginal = await readFile(backgroundFile, 'utf8')
  const backgroundVersion = async () => {
    const extensionURL = session.context
      .pages()[0]
      .url()
      .replace(/\/[^/]*$/, '/')
    const worker =
      session.context.serviceWorkers().find(worker => worker.url().startsWith(extensionURL)) ||
      (await session.context.waitForEvent('serviceworker', worker =>
        worker.url().startsWith(extensionURL)
      ))
    return worker.evaluate(() => globalThis.testLaunchVersion)
  }
  let session

  try {
    await writeFile(file, original.replace('<body hidden', '<body hidden data-launch="initial"'))
    await writeFile(
      backgroundFile,
      'globalThis.testLaunchVersion = "initial";\n' + backgroundOriginal
    )
    try {
      session = await launchBrowser('chrome', { headless: true, profileDir })
    } catch (error) {
      test.skip(
        error.message.startsWith('Install Google Chrome'),
        'Install Google Chrome to check the development launcher'
      )
      throw error
    }

    let page = session.context.pages()[0]
    await expect(page.locator('body')).toBeVisible()
    await expect(page.locator('body')).toHaveAttribute('data-launch', 'initial')
    expect(await backgroundVersion()).toBe('initial')
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
    await writeFile(
      backgroundFile,
      'globalThis.testLaunchVersion = "reloaded";\n' + backgroundOriginal
    )
    await session.reload()
    page = session.context.pages().find(page => page.url().startsWith('chrome-extension://'))
    await expect(page.locator('body')).toHaveAttribute('data-launch', 'reloaded')
    expect(await backgroundVersion()).toBe('reloaded')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await session.close()

    await writeFile(file, original.replace('<body hidden', '<body hidden data-launch="fresh"'))
    await writeFile(
      backgroundFile,
      'globalThis.testLaunchVersion = "fresh";\n' + backgroundOriginal
    )
    session = await launchBrowser('chrome', { headless: true, profileDir })
    page = session.context.pages()[0]
    await expect(page.locator('body')).toBeVisible()
    await expect(page.locator('body')).toHaveAttribute('data-launch', 'fresh')
    expect(await backgroundVersion()).toBe('fresh')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  } finally {
    await session?.close()
    await writeFile(file, original)
    await writeFile(backgroundFile, backgroundOriginal)
    await rm(profileDir, { recursive: true, force: true })
  }
})

test('development Chrome exports logs across restarts with retained download history', async ({
  browserName
}) => {
  test.skip(browserName !== 'chromium', 'Native Chrome downloads are checked once')
  test.setTimeout(60000)
  await build()
  const directory = await mkdtemp(path.join(tmpdir(), 'mega-native-downloads-'))
  const profileDir = path.join(directory, 'profile')
  const downloads = path.join(directory, 'downloads')
  await mkdir(path.join(profileDir, 'Default'), { recursive: true })
  await mkdir(downloads)
  await writeFile(
    path.join(profileDir, 'Default', 'Preferences'),
    JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } })
  )
  let session
  try {
    for (let run = 0; run < 3; run++) {
      session = await launchBrowser('chrome', { headless: true, profileDir })
      const page = session.context.pages()[0]
      await page.goto(page.url().replace('popup.html', 'log.html'))
      await expect(page.locator('body')).toBeVisible()
      await page.evaluate(async run => {
        const log = new globalThis.MegaDiagnosticLog()
        log.write('settings_changed', { profile: run })
        await log.flush()
      }, run)
      const previous = await readdir(downloads)
      await page.locator('#log-export').click()
      await expect
        .poll(async () => (await readdir(downloads)).filter(file => file.endsWith('.log')).length)
        .toBe(run + 1)
      const exported = (await readdir(downloads)).find(
        file => file.endsWith('.log') && !previous.includes(file)
      )
      expect(await readFile(path.join(downloads, exported), 'utf8')).toContain(`"profile":${run}`)
      expect(session.context.browser().isConnected()).toBe(true)
      await session.close()
      const preferences = JSON.parse(
        await readFile(path.join(profileDir, 'Default', 'Preferences'), 'utf8')
      )
      expect(preferences.profile.exit_type).toBe('Normal')
    }
  } finally {
    await session?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
