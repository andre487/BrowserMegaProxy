import { watch } from 'node:fs'
import { spawn } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { installFirefoxAddon, quitFirefox } from './firefox-addon.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

export function selectBrowser(args = process.argv.slice(2), env = process.env) {
  if (args.some(arg => !['--chrome', '--firefox', '--watch'].includes(arg))) {
    throw new Error('Use npm start -- [--chrome|--firefox] [--watch]')
  }

  const chrome = args.includes('--chrome') || env.npm_config_chrome === 'true'
  const firefox = args.includes('--firefox') || env.npm_config_firefox === 'true'
  if (chrome && firefox) {
    throw new Error('Choose one browser: --chrome or --firefox')
  }

  return firefox ? 'firefox' : 'chrome'
}

async function browserExecutable(browser) {
  if (process.platform === 'linux' && browser === 'firefox') {
    return 'firefox'
  }

  const app = browser === 'chrome' ? 'Google Chrome' : 'Firefox'
  const binary = browser === 'chrome' ? 'Google Chrome' : 'firefox'
  const windowsPath =
    browser === 'chrome'
      ? ['Google', 'Chrome', 'Application', 'chrome.exe']
      : ['Mozilla Firefox', 'firefox.exe']
  const candidates =
    process.platform === 'linux'
      ? ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']
      : process.platform === 'darwin'
        ? [`/Applications/${app}.app/Contents/MacOS/${binary}`]
        : [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
            .filter(Boolean)
            .map(base => path.join(base, ...windowsPath))

  for (const executable of candidates) {
    try {
      await access(executable)

      return executable
    } catch {}
  }

  throw new Error(`Install ${app} in its standard location (or provide executablePath)`)
}

async function launchChrome(profileDir, headless, executablePath) {
  const child = spawn(
    executablePath || (await browserExecutable('chrome')),
    [
      `--user-data-dir=${profileDir}`,
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      ...(headless ? ['--headless'] : [])
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' }
  )
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  let timer
  let browser
  try {
    const endpoint = await Promise.race([
      new Promise((resolve, reject) => {
        let stderr = ''
        child.stderr.on('data', data => {
          stderr = (stderr + data.toString()).slice(-65536)
          const match = stderr.match(/DevTools listening on (ws:\/\/[^\r\n]+)[\r\n]/)
          if (match) {
            resolve(match[1])
          }
        })
        timer = setTimeout(() => reject(new Error('Chrome debugging endpoint timed out')), 30000)
      }),
      closed.then(({ code, signal }) => {
        throw new Error(`Chrome exited before connecting (${signal || code})`)
      })
    ])
    clearTimeout(timer)
    // Leave native downloads alone: overriding them crashes Chrome with retained download history (crbug.com/556160935).
    browser = await chromium.connectOverCDP(endpoint, { noDefaults: true })
    let closing
    const close = () =>
      (closing ||= (async () => {
        if (browser.isConnected()) {
          await browser
            .newBrowserCDPSession()
            .then(cdp => cdp.send('Browser.close'))
            .catch(error => {
              if (browser.isConnected()) {
                throw error
              }
            })
        }
        await closed
        await browser.close()
      })())
    return { context: browser.contexts()[0], close, closed }
  } catch (error) {
    clearTimeout(timer)
    child.kill()
    await closed.catch(() => {})
    await browser?.close()
    throw error
  }
}

export async function launchBrowser(
  browser,
  {
    headless = false,
    profileDir = path.join(root, '.browser-profiles', browser),
    executablePath
  } = {}
) {
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) {
    throw new Error('Supported systems: macOS, Linux, Windows')
  }

  if (!['chrome', 'firefox'].includes(browser)) {
    throw new Error('Unknown browser')
  }

  const extension = path.join(root, 'dist', browser === 'chrome' ? 'chromium' : 'firefox')
  await mkdir(profileDir, { recursive: true })

  if (browser === 'chrome') {
    const session = await launchChrome(profileDir, headless, executablePath)
    const { context } = session

    try {
      const cdp = await context.browser().newBrowserCDPSession()
      const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension })
      let page = context.pages()[0] || (await context.newPage())
      await page.goto(`chrome-extension://${id}/popup.html`)
      await page.locator('body').waitFor({ state: 'visible' })
      // A persistent profile can start the previous cached service worker before loadUnpacked.
      const freshPage = await context.newPage()
      await page.close()
      await cdp.send('Extensions.loadUnpacked', { path: extension })
      await cdp.detach()
      page = freshPage
      await page.goto(`chrome-extension://${id}/popup.html`)

      return {
        context,
        reload: async () => {
          const pages = context
            .pages()
            .filter(page => page.url().startsWith(`chrome-extension://${id}/`))
          const urls = pages.map(page => page.url())
          for (const page of pages) {
            await page.close()
          }

          const cdp = await context.browser().newBrowserCDPSession()
          try {
            await cdp.send('Extensions.loadUnpacked', { path: extension })
          } finally {
            await cdp.detach()
          }

          for (const url of urls) {
            const page = await context.newPage()
            await page.goto(url)
          }
        },
        close: session.close,
        closed: session.closed
      }
    } catch (error) {
      await session.close()
      throw error
    }
  }

  const executable = executablePath || (await browserExecutable('firefox'))
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))

  await writeFile(
    path.join(profileDir, 'user.js'),
    [
      'user_pref("devtools.chrome.enabled", true);',
      'user_pref("devtools.debugger.remote-enabled", true);',
      'user_pref("devtools.debugger.prompt-connection", false);',
      'user_pref("devtools.debugger.force-local", true);'
    ].join('\n') + '\n'
  )

  // Firefox requires this permission to manage proxy.settings, including regular windows.
  const preferencesFile = path.join(profileDir, 'extension-preferences.json')
  let preferences = {}
  try {
    preferences = JSON.parse(await readFile(preferencesFile, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }
  }

  preferences['browser-mega-proxy@andre487'] = {
    permissions: ['internal:privateBrowsingAllowed'],
    origins: ['<all_urls>']
  }
  await writeFile(preferencesFile, JSON.stringify(preferences))

  const child = spawn(
    executable,
    [
      '-no-remote',
      ...(process.platform === 'darwin' ? ['-foreground'] : []),
      ...(process.platform === 'win32' ? ['-wait-for-browser'] : []),
      '-profile',
      profileDir,
      ...(headless ? ['--headless'] : []),
      '--start-debugger-server',
      String(port),
      'about:addons'
    ],
    { stdio: 'inherit', detached: process.platform !== 'win32' }
  )
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })

  try {
    await Promise.race([
      installFirefoxAddon(port, extension),
      closed.then(({ code, signal }) => {
        throw new Error(
          `Firefox exited before the extension was installed (${signal ? `signal ${signal}` : `code ${code}`})`
        )
      })
    ])

    let closing
    return {
      reload: () => installFirefoxAddon(port, extension),
      close: () =>
        (closing ||= (async () => {
          if (child.exitCode !== null || child.signalCode !== null) {
            return
          }
          await quitFirefox(port)
          await closed
        })()),
      closed
    }
  } catch (error) {
    child.kill()
    throw error
  }
}

export function watchSources(
  rebuild,
  {
    sources = [path.join(root, 'extension'), path.join(root, 'scripts')],
    onError = error => console.error(`Rebuild failed: ${error.message}`)
  } = {}
) {
  let timer
  let running = false
  let pending = false
  let stopped = false

  async function run() {
    if (running || stopped) {
      return
    }

    running = true
    do {
      pending = false
      try {
        await rebuild()
      } catch (error) {
        onError(error)
      }

      if (stopped) {
        break
      }
    } while (pending)

    running = false
  }

  const watchers = sources.map(source => {
    const watcher = watch(source, { recursive: true }, (event, filename) => {
      if (
        source === path.join(root, 'scripts') &&
        filename &&
        filename.toString() !== 'build.mjs'
      ) {
        return
      }

      pending = true
      clearTimeout(timer)
      timer = setTimeout(run, 150)
    })
    watcher.on('error', onError)

    return watcher
  })

  return () => {
    stopped = true
    clearTimeout(timer)
    for (const watcher of watchers) {
      watcher.close()
    }
  }
}

export async function build() {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'build.mjs')], {
      cwd: root,
      stdio: 'inherit'
    })
    child.once('error', reject)
    child.once('exit', code =>
      code === 0 ? resolve() : reject(new Error(`Build exited with code ${code}`))
    )
  })
}

export async function start({ browser = selectBrowser(), ...launchOptions } = {}) {
  let session
  let stopWatching
  let stopping = false
  let signalStop
  const interrupted = new Promise(resolve => {
    signalStop = resolve
  })
  const stop = () => {
    stopping = true
    stopWatching?.()
    signalStop()
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, stop)
  }
  try {
    process.chdir(root)
    await build()
    if (stopping) {
      return
    }
    console.log(
      `Starting ${browser}; profile: ${launchOptions.profileDir || path.join(root, '.browser-profiles', browser)}`
    )
    session = await launchBrowser(browser, launchOptions)
    if (stopping) {
      return
    }
    if (process.argv.includes('--watch') || process.env.npm_config_watch === 'true') {
      stopWatching = watchSources(
        async () => {
          await build()
          if (stopping) {
            return
          }
          await session.reload()
          console.log('Rebuilt and reloaded extension.')
        },
        {
          onError: error => {
            if (!stopping) {
              console.error(`Rebuild failed: ${error.message}`)
            }
          }
        }
      )
      console.log('Watching extension/ and scripts/build.mjs for changes.')
    }

    console.log('Extension loaded. Close the browser or press Ctrl+C to stop.')
    await Promise.race([session.closed, interrupted])
  } catch (error) {
    if (!stopping) {
      console.error(`Unable to start: ${error.message}`)
      console.error(
        'Install/update the selected browser and close any previous development session using this profile.'
      )
      process.exitCode = 1
    }
  } finally {
    stopWatching?.()
    try {
      await session?.close()
      await session?.closed
    } finally {
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.off(signal, stop)
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await start()
}
