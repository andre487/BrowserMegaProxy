/* global chrome */
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { launchExtension } from './browser-extension.mjs'

const credential = `Basic ${Buffer.from('user:secret').toString('base64')}`

const listen = server =>
  new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

const stop = server =>
  new Promise(resolve => {
    server.closeAllConnections?.()
    server.close(resolve)
  })

for (const scenario of ['auto', 'challenge']) {
  // Playwright requires fixture destructuring, even when no fixtures are used.
  // eslint-disable-next-line no-empty-pattern
  test(`installed extension routes and authenticates (${scenario})`, async ({}, testInfo) => {
    test.skip(
      testInfo.project.name === 'chromium' && scenario === 'auto',
      'Chromium supports only challenge authentication'
    )
    const dir = await mkdtemp(path.join(tmpdir(), 'mega-extension-'))
    let context
    let proxy, origin, secondary
    let closeBrowser
    let firefoxCommand
    const sockets = new Set()
    try {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          `${dir}/key.pem`,
          '-out',
          `${dir}/cert.pem`,
          '-subj',
          '/CN=target.invalid',
          '-days',
          '1'
        ],
        { stdio: 'ignore' }
      )
      const requests = []
      const originHeaders = []
      const tlsOptions = {
        key: await readFile(`${dir}/key.pem`),
        cert: await readFile(`${dir}/cert.pem`)
      }
      origin = https.createServer(tlsOptions, (req, res) => {
        originHeaders.push(req.headers)
        const host = req.headers.host.split(':')[0]
        res.setHeader('Connection', 'close')
        if (host === 'raw.githubusercontent.com') {
          res.setHeader('Content-Type', 'text/plain')
          res.end('subscription.invalid\nchild.subscription.invalid\n127.0.0.1\n')
          return
        }
        if (req.url === '/split') {
          res.setHeader('Content-Type', 'text/html')
          res.end(`<p>Split routing page</p><img src="https://[::1]:${originPort}/resource">`)
          return
        }
        if (req.url === '/resource') {
          res.setHeader('Content-Type', 'image/svg+xml')
          res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>')
          return
        }
        res.end(
          ['ifconfig.me', 'api.ipify.org', 'icanhazip.com'].includes(host)
            ? '203.0.113.7'
            : ['ifconfig.co', 'ipapi.co'].includes(host)
              ? 'US'
              : host === 'api.country.is'
                ? '{"country":"US"}'
                : 'Reached target through Mega Proxy'
        )
      })

      const originPort = await new Promise(resolve =>
        origin.listen(0, '::', () => resolve(origin.address().port))
      )
      const proxyFactory =
        testInfo.project.name === 'firefox' && scenario === 'auto'
          ? handler => https.createServer(tlsOptions, handler)
          : http.createServer
      proxy = proxyFactory((req, res) => {
        requests.push({ target: req.url, auth: req.headers['proxy-authorization'] })
        res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="MegaProxy"' }).end()
      })

      proxy.on('connect', (req, client, head) => {
        sockets.add(client)
        client.on('close', () => sockets.delete(client))
        const auth = req.headers['proxy-authorization']
        requests.push({ target: req.url, auth })
        if (auth !== credential) {
          const knock =
            req.url.startsWith('knock.invalid:') ||
            (testInfo.project.name === 'firefox' && scenario === 'challenge')
          client.end(
            knock
              ? 'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="MegaProxy"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
              : 'HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
          )

          return
        }

        const upstream = net.connect(originPort, '127.0.0.1', () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head.length) {
            upstream.write(head)
          }

          client.pipe(upstream).pipe(client)
        })
        sockets.add(upstream)
        upstream.on('close', () => sockets.delete(upstream))
        upstream.on('error', () => client.destroy())
        client.on('error', () => upstream.destroy())
        client.on('close', () => upstream.destroy())
      })

      const proxyPort = await listen(proxy)
      const target = testInfo.project.name
      const browser = await launchExtension(target, dir)
      context = browser.context
      const popupURL = browser.popupURL
      firefoxCommand = browser.command
      closeBrowser = browser.close

      let popup
      if (target === 'firefox') {
        const saved = await firefoxCommand({
          command: 'save',
          profile: {
            name: 'Local test',
            type: scenario === 'auto' ? 'https' : 'http',
            authMode: scenario,
            host: '127.0.0.1',
            port: proxyPort,
            username: 'user',
            password: 'secret',
            knockHost: 'knock.invalid',
            bypass: ['127.0.0.1']
          }
        })
        await firefoxCommand({ command: 'activate', id: saved.state.profiles[0].id })
      } else {
        popup = await context.newPage()
        await popup.goto(popupURL, { waitUntil: 'commit', timeout: 5000 })
        await expect(popup.locator('body')).toBeVisible()
        const optionsPagePromise = context.waitForEvent('page')
        await popup.locator('#open-settings').click()
        const options = await optionsPagePromise
        await expect(options).toHaveURL(/options\.html$/)
        await options.locator('#settings > summary').click()
        await options.locator('#language').selectOption('en')
        await expect(options.locator('html')).toHaveAttribute('lang', 'en')
        await options.getByRole('button', { name: 'Add' }).click()
        await options.getByLabel('Name', { exact: true }).fill('Local test')
        await options.getByLabel('Protocol').selectOption('http')
        await options.getByLabel('Proxy host').fill('127.0.0.1')
        await options.getByLabel('Port', { exact: true }).fill(String(proxyPort))
        await options.getByLabel('Username').fill('user')
        await options.getByLabel('Password', { exact: true }).fill('secret')
        await options.getByLabel('Knock host').fill('knock.invalid')
        await options.getByRole('button', { name: 'Save profile' }).click()
        await expect(options.locator('.profile')).toHaveCount(1)
        await expect(popup.locator('.profile')).toHaveCount(1)
        // An already-open proxied tab must reload lazily only after authentication succeeds.
        const existing = await context.newPage()
        const existingURL = `https://127.0.0.1:${originPort}/existing`
        await existing.goto(existingURL)
        await browser.command({ command: 'bypassLocalNetworks', enabled: false })
        await popup.bringToFront()
        const knockPagePromise = target === 'chromium' ? context.waitForEvent('page') : null
        await popup.getByRole('button', { name: 'Select', exact: true }).click()
        await expect(popup.locator('#connection')).toHaveText('Profile: Local test')
        if (knockPagePromise) {
          const knockPage = await knockPagePromise
          await expect.poll(() => knockPage.isClosed()).toBe(true)
          expect(requests.find(r => r.target === 'knock.invalid:443')?.auth).toBeUndefined()
          expect(
            requests.some(r => r.target === 'knock.invalid:443' && r.auth === credential)
          ).toBe(true)
          const worker = context.serviceWorkers()[0]
          const existingTabId = await worker.evaluate(
            async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id,
            existingURL
          )
          await expect
            .poll(
              async () =>
                requests.some(
                  r => r.target === `127.0.0.1:${originPort}` && r.auth === credential
                ) ||
                (await worker.evaluate(
                  async id =>
                    (await chrome.storage.session.get('knockRefresh')).knockRefresh?.tabs.some(
                      tab => tab.id === id
                    ),
                  existingTabId
                ))
            )
            .toBe(true)
          await worker.evaluate(id => chrome.tabs.update(id, { active: true }), existingTabId)
          await expect
            .poll(() =>
              requests.some(r => r.target === `127.0.0.1:${originPort}` && r.auth === credential)
            )
            .toBe(true)
          await expect
            .poll(async () =>
              worker.evaluate(
                async id =>
                  (await chrome.storage.session.get('knockRefresh')).knockRefresh.tabs.some(
                    tab => tab.id === id
                  ),
                existingTabId
              )
            )
            .toBe(false)
          await existing.close()
        }
      }

      const page = await context.newPage()
      await page.goto('https://target.invalid/')
      await expect(page.locator('body')).toContainText('Reached target')
      const first = requests.find(r => r.target === 'target.invalid:443')
      if (target === 'firefox' && scenario === 'challenge') {
        expect(first?.auth).toBeUndefined()
        expect(requests.some(r => r.target === 'target.invalid:443' && r.auth === credential)).toBe(
          true
        )
      } else {
        expect(first?.auth).toBe(credential)
      }
      expect(
        originHeaders.every(headers => !headers['proxy-authorization'] && !headers.authorization)
      ).toBe(true)

      const command =
        target === 'firefox'
          ? firefoxCommand
          : message => popup.evaluate(message => chrome.runtime.sendMessage(message), message)
      await command({ command: 'bypassLocalNetworks', enabled: false })
      await command({
        command: 'routing',
        routing: {
          enabled: true,
          mode: 'domains',
          domains: ['*.invalid'],
          sites: ['target.invalid']
        }
      })
      await page.goto('https://selected.invalid/split')
      await expect(page.locator('body')).toContainText('Split routing page')
      await expect(page.locator('img')).toHaveJSProperty('naturalWidth', 1)
      expect(requests.some(r => r.target === 'selected.invalid:443' && r.auth === credential)).toBe(
        true
      )
      expect(requests.some(r => r.target === `[::1]:${originPort}`)).toBe(false)
      const direct = await context.newPage()
      await direct.goto(`https://[::1]:${originPort}/split`)
      await expect(direct.locator('img')).toHaveJSProperty('naturalWidth', 1)
      if (target === 'firefox') {
        await command({
          command: 'routing',
          routing: { enabled: true, mode: 'tabs', domains: [], sites: ['target.invalid'] }
        })
        await page.goto('https://target.invalid/split')
        await expect(page.locator('img')).toHaveJSProperty('naturalWidth', 1)
        const proxiedResources = requests.filter(r => r.target === `[::1]:${originPort}`).length
        expect(proxiedResources).toBeGreaterThan(0)
        await direct.reload()
        await expect(direct.locator('img')).toHaveJSProperty('naturalWidth', 1)
        expect(requests.filter(r => r.target === `[::1]:${originPort}`).length).toBe(
          proxiedResources
        )
        await direct.bringToFront()
        expect((await command({ command: 'currentSite' })).currentSite.hostname).toBe('::1')
        const proxied = await command({ command: 'toggleTab' })
        expect(proxied.currentSite.proxied).toBe(true)
        await expect
          .poll(() => requests.filter(r => r.target === `[::1]:${originPort}`).length)
          .toBeGreaterThan(proxiedResources)
        await direct.waitForLoadState('load')
        const afterToggle = requests.filter(r => r.target === `[::1]:${originPort}`).length
        const unproxied = await command({ command: 'toggleTab' })
        expect(unproxied.currentSite.proxied).toBe(false)
        await direct.waitForLoadState('load')
        expect(requests.filter(r => r.target === `[::1]:${originPort}`).length).toBe(afterToggle)
      }
      if (target === 'firefox') {
        const secondaryRequests = []
        secondary = proxyFactory((req, res) =>
          res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="MegaProxy"' }).end()
        )
        secondary.on('connect', (req, client, head) => {
          secondaryRequests.push(req.url)
          proxy.listeners('connect')[0](req, client, head)
        })
        const secondaryPort = await listen(secondary)
        const saved = await command({
          command: 'save',
          profile: {
            id: 'assigned',
            name: 'Assigned',
            type: scenario === 'auto' ? 'https' : 'http',
            host: '127.0.0.1',
            port: secondaryPort,
            username: 'user',
            password: 'secret'
          }
        })
        const activeId = saved.state.activeId
        await command({ command: 'activate', id: 'assigned' })
        await command({
          command: 'routing',
          routing: {
            enabled: true,
            mode: 'tabs',
            sites: ['**.assigned.invalid']
          }
        })
        await page.goto('https://deep.assigned.invalid/split')
        await expect(page.locator('img')).toHaveJSProperty('naturalWidth', 1)
        expect(secondaryRequests).toContain('deep.assigned.invalid:443')
        expect(secondaryRequests).toContain(`[::1]:${originPort}`)
        expect((await command({ command: 'get' })).state.activeId).toBe('assigned')
        const tested = await command({
          command: 'testRule',
          url: 'https://cdn.invalid/resource',
          tabUrl: 'https://deep.assigned.invalid/'
        })
        expect(tested.profile.id).toBe('assigned')
        await command({ command: 'activate', id: activeId })
      }
      // Diagnostics must still use the active proxy even when no diagnostic host is listed.
      if (target === 'chromium') {
        await command({
          command: 'routing',
          routing: { enabled: true, mode: 'domains', domains: ['target.invalid'] }
        })
      }

      await command({
        command: 'routing',
        routing: {
          enabled: true,
          mode: target === 'firefox' ? 'tabs' : 'domains',
          domains: ['target.invalid'],
          sites: ['target.invalid'],
          subscriptions: {
            domainSources: ['youtube'],
            siteSources: target === 'firefox' ? ['youtube'] : [],
            throughProxy: true,
            autoUpdate: false
          }
        }
      })
      const updated = await command({ command: 'updateSubscriptions' })
      expect(
        updated.ok,
        JSON.stringify({ error: updated.error, targets: requests.map(r => r.target) })
      ).toBe(true)
      expect(updated.state.subscriptionCache.domains).toEqual(['**.subscription.invalid'])
      expect(updated.state.subscriptionCache.ignored).toBe(1)
      expect(
        requests.some(r => r.target === 'raw.githubusercontent.com:443' && r.auth === credential)
      ).toBe(true)
      await page.goto('https://child.subscription.invalid/split')
      await expect(page.locator('body')).toContainText('Split routing page')
      await expect(page.locator('img')).toHaveJSProperty('naturalWidth', 1)

      if (target === 'firefox') {
        const checked = await firefoxCommand({ command: 'check' })
        expect(checked.connectionCheck.exitIp).toBe('203.0.113.7')
        expect(checked.connectionCheck.countryCode).toBe('US')
      } else {
        await popup.locator('#check').click()
        await expect(popup.locator('#check-result')).toContainText('203.0.113.7')
        await expect(popup.locator('#check-result')).toContainText('US')
      }

      if (target === 'firefox') {
        expect((await firefoxCommand({ command: 'get' })).state.activeId).toBeTruthy()
        await firefoxCommand({ command: 'activate', id: null })
      } else {
        // Reload the UI: saved profiles and active selection must survive popup lifetime.
        await popup.reload()
        await expect(popup.locator('#connection')).toHaveText('Profile: Local test')
        await popup.getByRole('button', { name: 'Disconnect', exact: true }).click()
        await expect(popup.locator('#connection')).toHaveText('System settings')
      }
    } finally {
      await closeBrowser?.()
      for (const socket of sockets) {
        socket.destroy()
      }

      if (secondary) {
        await stop(secondary)
      }
      if (proxy) {
        await stop(proxy)
      }

      if (origin) {
        await stop(origin)
      }

      await rm(dir, { recursive: true, force: true })
    }
  })
}
