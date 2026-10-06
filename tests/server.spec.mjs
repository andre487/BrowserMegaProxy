import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { launchExtension } from './browser-extension.mjs'
import { probe, startServer } from './megaproxy-server/fixture.mjs'

const credentials = 'user:secret-password:with@symbols'

for (const scenario of ['challenge', 'knock', 'masked', 'override', 'chain-only', 'ip']) {
  // eslint-disable-next-line no-empty-pattern
  test(`MegaProxyServer: ${scenario}, real TLS, SNI routes, imports, routing and authentication failures`, async ({}, testInfo) => {
    test.setTimeout(120000)
    const target = testInfo.project.name
    const server = await startServer(scenario)
    const recordNetwork = async phase => {
      const diagnostics = `Network ${phase}: ${new Date().toISOString()}\n${await server.diagnostics()}`
      console.log(diagnostics)
      await testInfo.attach(`network-${phase}`, { body: diagnostics, contentType: 'text/plain' })
    }
    let browser
    try {
      await recordNetwork('start')
      const serverHost =
        scenario === 'ip'
          ? '127.0.0.1'
          : scenario === 'chain-only'
            ? 'chain.localhost'
            : 'direct.localhost'
      const primarySni = scenario === 'ip' ? '' : serverHost
      const unmasked = ['challenge', 'chain-only', 'ip'].includes(scenario)
      const ordinary = await probe(server.proxyPort, primarySni, 'target.invalid:443')
      expect(ordinary).toMatch(unmasked ? /^HTTP\/1\.1 407/ : /^HTTP\/1\.1 (?:200|404)/)
      expect(ordinary.includes('Proxy-Authenticate:')).toBe(unmasked)
      const knock = await probe(
        server.proxyPort,
        scenario === 'ip' ? '' : 'chain.localhost',
        'knock.invalid:443'
      )
      expect(knock).toMatch(scenario === 'masked' ? /^HTTP\/1\.1 (?:200|404)/ : /^HTTP\/1\.1 407/)
      expect(
        await probe(server.proxyPort, primarySni, 'target.invalid:443', credentials, {
          ca: server.ca,
          rejectUnauthorized: true
        })
      ).toMatch(/^HTTP\/1\.1 200/)
      if (scenario === 'ip') {
        expect(
          await probe(server.proxyPort, 'unknown.localhost', 'target.invalid:443', credentials)
        ).toMatch(/^HTTP\/1\.1 200/)
      } else {
        await expect(
          probe(server.proxyPort, 'unknown.localhost', 'target.invalid:443', credentials)
        ).rejects.toThrow()
      }
      if (scenario === 'chain-only') {
        await expect(
          probe(server.proxyPort, 'direct.localhost', 'target.invalid:443', credentials)
        ).rejects.toThrow()
      }

      browser = await launchExtension(target, `${server.dir}/good`)
      const { command, context } = browser
      if (target === 'chromium') {
        expect(
          (await command({ command: 'previewImport', data: server.selfSignedExport })).error
        ).toBe('errorImportCompatible')
      } else {
        await expect(
          command({ command: 'previewImport', data: server.selfSignedExport })
        ).rejects.toThrow('errorImportCompatible')
      }
      for (const [format, data] of Object.entries(server.exports)) {
        const preview = await command({ command: 'previewImport', data })
        expect(preview.ok, format).toBe(true)
        if (format === 'MegaProxy.json') {
          expect(preview.skipped).toHaveLength(4)
          expect(JSON.parse(data).profiles.some(p => p.proxy.type === 'SSH_JUMP')).toBe(true)
        }
        const imported = await command({ command: 'import', data })
        expect(imported.ok, format).toBe(true)
        const p = imported.state.profiles.find(p => p.host === serverHost)
        expect(p.type).toBe('https')
        expect(p.port).toBe(server.proxyPort)
        expect(p.username).toBe('user')
        expect(p.password).toBe('secret-password:with@symbols')
      }
      const state = (await command({ command: 'get' })).state
      const direct = state.profiles.find(
        p => p.host === (scenario === 'ip' ? '127.0.0.1' : 'direct.localhost')
      )
      const chain = state.profiles.find(p => p.host === 'chain.localhost')
      if (scenario !== 'ip') {
        expect(chain).toBeTruthy()
      }
      const entry = direct || chain
      expect(
        JSON.stringify((await command({ command: 'export', includePasswords: true })).config)
      ).not.toContain('machine-password-not-for-clients')
      let page = await context.newPage()

      // Chromium needs a challenge even with saved credentials. Masking without a knock
      // cannot bootstrap its proxy authentication and must not silently connect directly.
      if (target === 'chromium' && scenario === 'masked') {
        const activated = await command({ command: 'activate', id: direct.id })
        expect(activated.ok).toBe(true)
        expect(activated.state.activeId).toBe(direct.id)
        expect(activated.warning).toBeUndefined()
        await expect(page.goto('https://target.invalid/', { timeout: 5000 })).rejects.toThrow()
        expect((await server.requests()).filter(r => r.host === 'target.invalid')).toHaveLength(0)
        const saved = await command({
          command: 'save',
          profile: { ...direct, knockHost: 'knock.invalid' }
        })
        await command({
          command: 'activate',
          id: saved.state.profiles.find(p => p.id === direct.id).id
        })
        await expect(page.goto('https://target.invalid/', { timeout: 5000 })).rejects.toThrow()
        expect((await server.requests()).filter(r => r.host === 'target.invalid')).toHaveLength(0)
        return
      }

      for (const [profile, expectedAddress] of [
        [direct, server.entryAddress],
        [chain, server.exitAddress]
      ].filter(([profile]) => profile)) {
        await command({ command: 'save', profile: { ...profile, knockHost: 'knock.invalid' } })
        const authBefore = (await browser.authEvents()).length
        const knockBefore = (await server.requests()).filter(
          r => r.host === 'knock.invalid' && r.remoteAddress === expectedAddress
        ).length
        await command({ command: 'activate', id: profile.id })
        if (target === 'chromium') {
          // Target browsing starts only after the knock has populated the browser auth cache.
          await expect
            .poll(
              async () =>
                (await server.requests()).filter(
                  r => r.host === 'knock.invalid' && r.remoteAddress === expectedAddress
                ).length
            )
            .toBeGreaterThan(knockBefore)
          // Knock success also closes its tab and can refresh a previously opened target tab.
          // Finish that lifecycle before starting a new navigation on an unmarked page.
          await expect
            .poll(
              () =>
                context.pages().filter(tab => tab.url().startsWith('https://knock.invalid/')).length
            )
            .toBe(0)
          const previousPage = page
          page = await context.newPage()
          await previousPage.close()
        }
        await page.goto(`https://target.invalid/${profile.id}`)
        await expect(page.locator('body')).toHaveText('MegaProxyServer origin')
        const request = (await server.requests()).find(r => r.path === `/${profile.id}`)
        expect(request.remoteAddress).toBe(expectedAddress)
        expect(request.headers.authorization).toBeUndefined()
        expect(request.headers['proxy-authorization']).toBeUndefined()
        const events = (await browser.authEvents()).slice(authBefore)
        if (target === 'firefox') {
          // Saved credentials must preauthenticate against real GOST, including masking.
          expect(events).toHaveLength(0)
        } else {
          expect(events.some(e => e.isProxy && e.url.startsWith('https://knock.invalid/'))).toBe(
            true
          )
        }
      }

      expect((await command({ command: 'get' })).statistics).toBeDefined()
      await command({ command: 'statistics', enabled: false })
      expect((await command({ command: 'get' })).statistics).toBeUndefined()
      await command({ command: 'statistics', enabled: true })
      await page.goto('https://target.invalid/statistics')
      await expect
        .poll(async () => (await command({ command: 'get' })).statistics.completed)
        .toBeGreaterThan(0)
      await command({ command: 'bypassLocalNetworks', enabled: true })
      await page.waitForLoadState('networkidle')
      const counted = (await command({ command: 'get' })).statistics.completed
      await page.goto(`https://127.0.0.1:${server.originTlsPort}/direct-local`)
      await expect(page.locator('body')).toHaveText('MegaProxyServer origin')
      expect((await command({ command: 'get' })).statistics.completed).toBe(counted)
      await command({ command: 'statistics', enabled: false })
      expect((await command({ command: 'get' })).statistics).toBeUndefined()

      await command({
        command: 'routing',
        routing: { enabled: true, mode: 'domains', domains: ['**.invalid'] }
      })
      await page.goto('https://target.invalid/split')
      await expect(page.locator('img')).toHaveJSProperty('naturalWidth', 1)
      if (target === 'firefox') {
        await command({
          command: 'routing',
          routing: { enabled: true, mode: 'tabs', sites: ['target.invalid'] }
        })
        await page.goto('https://target.invalid/split')
        await expect(page.locator('img')).toHaveJSProperty('naturalWidth', 1)
      }
      await command({
        command: 'routing',
        routing: {
          enabled: true,
          mode: target === 'firefox' ? 'tabs' : 'domains',
          domains: ['target.invalid'],
          sites: ['target.invalid'],
          subscriptions: {
            autoUpdate: false,
            throughProxy: true,
            domainSources: ['youtube'],
            siteSources: target === 'firefox' ? ['youtube'] : []
          }
        }
      })
      const refreshed = await command({ command: 'updateSubscriptions' })
      expect(refreshed.ok, JSON.stringify(refreshed)).toBe(true)
      expect(refreshed.state.subscriptionCache[target === 'firefox' ? 'sites' : 'domains']).toEqual(
        ['**.subscription.invalid']
      )
      await page.goto('https://child.subscription.invalid/')
      await expect(page.locator('body')).toHaveText('MegaProxyServer origin')
      const checked = await command({ command: 'check' })
      expect(checked.connectionCheck.exitIp).toBe('203.0.113.7')
      expect(checked.connectionCheck.countryCode).toBe('US')

      await command({ command: 'routing', routing: { enabled: false } })
      if (chain && direct) {
        await server.stopExit()
        await command({ command: 'statistics', enabled: true })
        const beforeFailure = (await server.requests()).length
        await expect(page.goto('https://failure.invalid/', { timeout: 5000 })).rejects.toThrow()
        expect((await server.requests()).length).toBe(beforeFailure)
        expect((await command({ command: 'get' })).state.activeId).toBe(chain.id)
        await expect
          .poll(async () => (await command({ command: 'get' })).statistics.failed)
          .toBeGreaterThan(0)
        await command({ command: 'activate', id: direct.id })
        const recoveredPage = await context.newPage()
        await recoveredPage.goto('https://target.invalid/direct-still-works')
        await expect(recoveredPage.locator('body')).toHaveText('MegaProxyServer origin')
      }

      // A fresh browser profile prevents successful cached credentials from hiding bad ones.
      await browser.close()
      browser = undefined
      await mkdir(`${server.dir}/wrong`, { recursive: true })
      browser = await launchExtension(target, `${server.dir}/wrong`)
      const saved = await browser.command({
        command: 'save',
        profile: { ...entry, password: 'wrong-password', knockHost: 'knock.invalid' }
      })
      await browser.command({ command: 'activate', id: saved.state.profiles[0].id })
      const badPage = await browser.context.newPage()
      const requestsBeforeBad = (await server.requests()).length
      await expect(badPage.goto('https://wrong.invalid/', { timeout: 5000 })).rejects.toThrow()
      expect((await server.requests()).length).toBe(requestsBeforeBad)
      expect((await browser.command({ command: 'get' })).state.activeId).toBe(entry.id)

      // Without saved credentials both browsers must open a knock tab for the native prompt.
      await browser.close()
      browser = undefined
      browser = await launchExtension(target, `${server.dir}/unsaved`)
      const authFailures = (await server.logs()).split('http2: authentication failed').length
      const tabsBefore = (await browser.createdTabs()).length
      const unsaved = await browser.command({
        command: 'save',
        profile: { ...entry, username: '', password: '', knockHost: 'knock.invalid' }
      })
      const activated = await browser.command({
        command: 'activate',
        id: unsaved.state.profiles[0].id
      })
      expect(activated.warning).toBeUndefined()
      await expect
        .poll(async () => (await browser.createdTabs()).length)
        .toBeGreaterThan(tabsBefore)
      if (scenario !== 'masked') {
        await expect
          .poll(async () => (await server.logs()).split('http2: authentication failed').length)
          .toBeGreaterThan(authFailures)
      }
    } catch (error) {
      if (browser) {
        await testInfo.attach('browser-network-errors', {
          body: JSON.stringify(await browser.networkErrors(), null, 2),
          contentType: 'application/json'
        })
      }
      await testInfo.attach('server-logs', { body: await server.logs(), contentType: 'text/plain' })
      throw error
    } finally {
      try {
        try {
          await recordNetwork('end')
        } finally {
          await browser?.close()
        }
      } finally {
        await server.close()
      }
    }
  })
}
