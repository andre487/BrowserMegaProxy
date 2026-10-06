import { watch } from 'node:fs'
import { spawn } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { installFirefoxAddon } from './firefox-addon.mjs'

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

async function firefoxExecutable() {
  if (process.platform === 'linux') {
    return 'firefox'
  }

  const candidates =
    process.platform === 'darwin'
      ? ['/Applications/Firefox.app/Contents/MacOS/firefox']
      : [
          process.env.ProgramFiles &&
            path.join(process.env.ProgramFiles, 'Mozilla Firefox', 'firefox.exe'),
          process.env['ProgramFiles(x86)'] &&
            path.join(process.env['ProgramFiles(x86)'], 'Mozilla Firefox', 'firefox.exe'),
          process.env.LOCALAPPDATA &&
            path.join(process.env.LOCALAPPDATA, 'Mozilla Firefox', 'firefox.exe')
        ].filter(Boolean)

  for (const executable of candidates) {
    try {
      await access(executable)

      return executable
    } catch {}
  }

  throw new Error(
    'Install Firefox in its standard location (or make firefox available on PATH on Linux)'
  )
}

export async function launchBrowser(
  browser,
  { headless = false, profileDir = path.join(root, '.browser-profiles', browser) } = {}
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
    const context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chrome',
      headless,
      viewport: null,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging']
    })

    try {
      const cdp = await context.browser().newBrowserCDPSession()
      const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension })
      await cdp.detach()
      const page = context.pages()[0] || (await context.newPage())
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
        close: () => context.close(),
        closed: new Promise(resolve => context.once('close', resolve))
      }
    } catch (error) {
      await context.close()
      throw error
    }
  }

  const executable = await firefoxExecutable()
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
    { stdio: 'inherit' }
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

    return { reload: () => installFirefoxAddon(port, extension), close: () => child.kill(), closed }
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let session
  let stopWatching
  try {
    const browser = selectBrowser()
    process.chdir(root)
    await build()
    console.log(`Starting ${browser}; profile: ${path.join(root, '.browser-profiles', browser)}`)
    session = await launchBrowser(browser)
    if (process.argv.includes('--watch') || process.env.npm_config_watch === 'true') {
      stopWatching = watchSources(async () => {
        await build()
        await session.reload()
        console.log('Rebuilt and reloaded extension.')
      })
      console.log('Watching extension/ and scripts/build.mjs for changes.')
    }

    console.log('Extension loaded. Close the browser or press Ctrl+C to stop.')
    process.once('SIGINT', () => {
      stopWatching?.()
      session.close()
    })
    process.once('SIGTERM', () => {
      stopWatching?.()
      session.close()
    })
    await session.closed
  } catch (error) {
    await session?.close()
    console.error(`Unable to start: ${error.message}`)
    console.error(
      'Install/update the selected browser and close any previous development session using this profile.'
    )
    process.exitCode = 1
  } finally {
    stopWatching?.()
  }
}
