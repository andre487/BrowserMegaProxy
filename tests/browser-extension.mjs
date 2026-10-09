/* global chrome */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { chromium, firefox } from '@playwright/test'
import { installFirefoxAddon } from '../scripts/firefox-addon.mjs'

const listen = server =>
  new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const stop = server =>
  new Promise(resolve => {
    server.closeAllConnections?.()
    server.close(resolve)
  })

export async function launchExtension(target, dir, { grantPrivacy = false, systemProxy } = {}) {
  let extension = path.resolve(`dist/${target}`)
  if (grantPrivacy) {
    const copied = `${dir}/privacy-addon`
    await cp(extension, copied, { recursive: true })
    const manifest = JSON.parse(await readFile(`${copied}/manifest.json`, 'utf8'))
    manifest.permissions.push('privacy')
    manifest.optional_permissions = manifest.optional_permissions.filter(p => p !== 'privacy')
    await writeFile(`${copied}/manifest.json`, JSON.stringify(manifest))
    extension = copied
  }
  const userDataDir = `${dir}/profile`
  let context, control, firefoxCommand
  let popupURL
  if (target === 'chromium') {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      ignoreHTTPSErrors: true,
      // Worker fetches do not inherit Playwright page certificate exceptions.
      args: [
        ...(systemProxy ? [`--proxy-server=http://${systemProxy.host}:${systemProxy.port}`] : []),
        '--ignore-certificate-errors',
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`
      ]
    })
    const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'))
    popupURL = `chrome-extension://${worker.url().split('/')[2]}/popup.html`
    await worker.evaluate(() => {
      globalThis.testAuthEvents = []
      globalThis.testCreatedTabs = []
      globalThis.testNetworkErrors = []
      chrome.webRequest.onErrorOccurred.addListener(
        details =>
          globalThis.testNetworkErrors.push({
            url: details.url,
            error: details.error,
            proxyInfo: details.proxyInfo
          }),
        { urls: ['<all_urls>'] }
      )
      chrome.tabs.onCreated.addListener(tab =>
        globalThis.testCreatedTabs.push({ id: tab.id, url: tab.url, pendingUrl: tab.pendingUrl })
      )
      chrome.webRequest.onAuthRequired.addListener(
        details => {
          globalThis.testAuthEvents.push({ url: details.url, isProxy: details.isProxy })
        },
        { urls: ['<all_urls>'] }
      )
    })
  } else {
    // Playwright cannot instrument moz-extension pages. A test-only sidecar calls the
    // unmodified production handler; Playwright exercises actual browser requests below.
    let waiting, result
    const commands = []
    control = http.createServer(async (req, res) => {
      if (req.method === 'POST') {
        let body = ''
        for await (const chunk of req) {
          body += chunk
        }

        result?.(JSON.parse(body))
        result = null
        res.end('ok')
      } else if (commands.length) {
        res.end(JSON.stringify(commands.shift()))
      } else {
        waiting = res
      }
    })
    const controlPort = await listen(control)
    firefoxCommand = message =>
      new Promise((resolve, reject) => {
        result = value =>
          value.ok ? resolve(value) : reject(new Error(`${value.error} (${message.command})`))
        if (waiting) {
          waiting.end(JSON.stringify(message))
          waiting = null
        } else {
          commands.push(message)
        }
      })
    const testAddon = `${dir}/addon`
    await cp(extension, testAddon, { recursive: true })
    const manifest = JSON.parse(await readFile(`${testAddon}/manifest.json`, 'utf8'))
    manifest.background.scripts.push('test-bridge.js')
    await writeFile(`${testAddon}/manifest.json`, JSON.stringify(manifest))
    await writeFile(
      `${testAddon}/test-bridge.js`,
      `
    (async () => {
      const endpoint = 'http://127.0.0.1:${controlPort}/'
      const authEvents = []
      const createdTabs = []
      const networkErrors = []
      api.webRequest.onErrorOccurred.addListener(details => networkErrors.push({url: details.url, error: details.error, proxyInfo: details.proxyInfo}), {urls: ['<all_urls>']})
      api.tabs.onCreated.addListener(tab => createdTabs.push({id: tab.id, url: tab.url, pendingUrl: tab.pendingUrl}))
      api.webRequest.onAuthRequired.addListener(details => { authEvents.push({url: details.url, isProxy: details.isProxy}) }, {urls: ['<all_urls>']})

      while (true) {
        const command = await (await fetch(endpoint)).json()
        let result

        try {
          result = command.command === 'testWindows' ? {ok: true, windows: await api.windows.getAll({populate: true})} : command.command === 'testTabState' ? { ok: true, tabs: await Promise.all((await api.tabs.query({})).map(async tab => ({ id: tab.id, url: tab.url, badge: await api.action.getBadgeText({tabId: tab.id}), title: await api.action.getTitle({tabId: tab.id}) }))) } : command.command === 'testCapabilities' ? {ok: true, sync: await api.storage.sync.get(null), policy: (await api.privacy.network.webRTCIPHandlingPolicy.get({})).value, peer: (await api.privacy.network.peerConnectionEnabled.get({})).value, menus: await Promise.all(['toggleTab', ...state.profiles.map(p => 'profile:' + p.id)].map(async id => { await api.contextMenus.update(id, {enabled: true}); return {id} }))} : command.command === 'testAuthEvents' ? {ok: true, events: authEvents} : command.command === 'testNetworkErrors' ? {ok: true, networkErrors} : command.command === 'testTabsCreated' ? {ok: true, createdTabs} : await handle(command)
        } catch (error) {
          result = {ok: false, error: error.message}
        }

        await fetch(endpoint, {method: 'POST', body: JSON.stringify(result)})
      }
    })()
  `
    )
    const temporaryServer = net.createServer()
    const debugPort = await listen(temporaryServer)
    await stop(temporaryServer)
    await mkdir(userDataDir, { recursive: true })
    // Pre-grant Firefox's required private browsing permission in this isolated profile.
    await writeFile(
      `${userDataDir}/extension-preferences.json`,
      JSON.stringify({
        'browser-mega-proxy@andre487': {
          permissions: ['internal:privateBrowsingAllowed'],
          origins: ['<all_urls>']
        }
      })
    )
    context = await firefox.launchPersistentContext(userDataDir, {
      headless: true,
      ignoreHTTPSErrors: true,
      args: ['--start-debugger-server', String(debugPort), '--new-window', 'about:blank'],
      firefoxUserPrefs: {
        ...(systemProxy
          ? {
              'network.proxy.type': 1,
              'network.proxy.http': systemProxy.host,
              'network.proxy.http_port': systemProxy.port,
              'network.proxy.ssl': systemProxy.host,
              'network.proxy.ssl_port': systemProxy.port,
              'network.proxy.no_proxies_on': 'localhost,127.0.0.1'
            }
          : {}),
        'devtools.debugger.remote-enabled': true,
        'devtools.debugger.prompt-connection': false
      }
    })
    await installFirefoxAddon(debugPort, testAddon)
    await firefoxCommand({ command: 'get' })
  }

  let commandPage
  if (target === 'chromium') {
    commandPage = await context.newPage()
    await commandPage.goto(popupURL)
    await commandPage.waitForSelector('body', { state: 'visible' })
  }

  return {
    context,
    popupURL,
    command:
      target === 'firefox'
        ? firefoxCommand
        : message =>
            message.command === 'testTabState'
              ? commandPage.evaluate(async () => ({
                  ok: true,
                  tabs: await Promise.all(
                    (await chrome.tabs.query({})).map(async tab => ({
                      id: tab.id,
                      url: tab.url,
                      badge: await chrome.action.getBadgeText({ tabId: tab.id }),
                      title: await chrome.action.getTitle({ tabId: tab.id })
                    }))
                  )
                }))
              : message.command === 'testWindows'
                ? commandPage.evaluate(async () => ({
                    ok: true,
                    windows: await chrome.windows.getAll({ populate: true })
                  }))
                : commandPage.evaluate(message => chrome.runtime.sendMessage(message), message),
    networkErrors: async () =>
      target === 'firefox'
        ? (await firefoxCommand({ command: 'testNetworkErrors' })).networkErrors
        : context.serviceWorkers()[0].evaluate(() => globalThis.testNetworkErrors),
    createdTabs: async () =>
      target === 'firefox'
        ? (await firefoxCommand({ command: 'testTabsCreated' })).createdTabs
        : context.serviceWorkers()[0].evaluate(() => globalThis.testCreatedTabs),
    authEvents: async () =>
      target === 'firefox'
        ? (await firefoxCommand({ command: 'testAuthEvents' })).events
        : context.serviceWorkers()[0].evaluate(() => globalThis.testAuthEvents),
    close: async () => {
      await context.close()
      if (control) {
        await stop(control)
      }
    }
  }
}
