/* global chrome, profileIcon: writable, profileIcons, updateBadge, state: writable */
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { launchExtension } from './browser-extension.mjs'

// eslint-disable-next-line no-empty-pattern
test('installed extension uses native privacy, sync storage, menus and URL import', async ({}, testInfo) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mega-features-'))
  const config = {
    schema: 'net.megaproxy487.config',
    version: 8,
    browser: { theme: 'dark' },
    profiles: [
      {
        id: 'remote',
        name: 'Remote',
        proxy: {
          type: 'HTTPS',
          host: 'proxy.example',
          port: 443,
          username: 'user',
          password: 'secret'
        }
      }
    ]
  }
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(config))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    // Test-only manifest grants optional privacy permission to avoid native dialogs.
    browser = await launchExtension(testInfo.project.name, dir, { grantPrivacy: true })
    const command = browser.command
    const snapshot = async () =>
      testInfo.project.name === 'firefox'
        ? command({ command: 'testCapabilities' })
        : browser.context.serviceWorkers()[0].evaluate(async () => ({
            sync: await chrome.storage.sync.get(null),
            policy: (await chrome.privacy.network.webRTCIPHandlingPolicy.get({})).value
          }))
    expect((await command({ command: 'get' })).syncOptions).toEqual({
      enabled: true,
      includePasswords: true
    })
    const downloaded = await command({
      command: 'fetchConfig',
      url: `http://127.0.0.1:${server.address().port}/config.json`
    })
    expect((await command({ command: 'get' })).state.profiles).toHaveLength(0)
    expect((await command({ command: 'previewImport', data: downloaded.data })).added).toBe(1)
    await command({ command: 'import', data: downloaded.data })
    expect((await command({ command: 'get' })).state.theme).toBe('dark')
    await expect
      .poll(async () => JSON.stringify((await snapshot()).sync).includes('secret'))
      .toBe(true)
    await command({ command: 'sync', enabled: true, includePasswords: false })
    await expect
      .poll(async () => JSON.stringify((await snapshot()).sync).includes('secret'))
      .toBe(false)
    await command({ command: 'webRTC', value: 'disable_non_proxied_udp' })
    expect((await snapshot()).policy).toBe('disable_non_proxied_udp')
    if (testInfo.project.name === 'firefox') {
      await command({ command: 'webRTC', value: 'disabled' })
      const current = await snapshot()
      expect(current.peer).toBe(false)
      expect(current.menus.map(menu => menu.id)).toContain('profile:remote')
      expect(current.menus.map(menu => menu.id)).toContain('toggleTab')
    }
    await command({ command: 'webRTC', value: 'browser' })
    expect((await snapshot()).policy).toBe('default')
    expect((await command({ command: 'testRule', url: 'https://example.com/' })).proxied).toBe(
      false
    )
    await command({ command: 'sync', enabled: false, includePasswords: false })
    const before = JSON.stringify((await snapshot()).sync)
    await command({ command: 'theme', theme: 'light' })
    expect(JSON.stringify((await snapshot()).sync)).toBe(before)
  } finally {
    await browser?.close()
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

// eslint-disable-next-line no-empty-pattern
test('native routing follows the selected profile, monitors failures, badges tabs and supports Direct/System', async ({}, testInfo) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mega-routing-'))
  const requests = [[], []]
  const servers = [0, 1].map(index => {
    const server = http.createServer((req, res) => {
      const credential = `Basic ${Buffer.from(`user${index}:secret${index}`).toString('base64')}`
      requests[index].push({ url: req.url, auth: req.headers['proxy-authorization'] })
      if (req.headers['proxy-authorization'] !== credential) {
        res.writeHead(407, { 'Proxy-Authenticate': `Basic realm="profile${index}"` }).end()
        return
      }
      if (req.url.includes('missing.invalid')) {
        res.writeHead(503).end('Unavailable')
        return
      }
      res.setHeader('Content-Type', 'text/html')
      res.end('<p>Routed page</p><img src="http://missing.invalid/resource?private=token">')
    })
    server.on('connect', (req, socket) =>
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
    )
    return server
  })
  const direct = http.createServer((req, res) => res.end('Direct page'))
  for (const server of [...servers, direct]) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  }
  let browser
  try {
    browser = await launchExtension(testInfo.project.name, dir)
    const command = browser.command
    await command({ command: 'sync', enabled: false, includePasswords: false })
    for (const index of [0, 1]) {
      await command({
        command: 'save',
        profile: {
          id: `profile${index}`,
          name: `Route${index}`,
          type: 'http',
          host: '127.0.0.1',
          port: servers[index].address().port,
          username: `user${index}`,
          password: `secret${index}`,
          knockHost: index === 0 ? 'knock.invalid' : ''
        }
      })
    }
    await command({ command: 'activate', id: 'profile0' })
    await command({
      command: 'routing',
      routing: {
        enabled: true,
        mode: 'domains',
        domains: ['first.invalid', 'second.invalid', 'missing.invalid']
      }
    })
    const page = await browser.context.newPage()
    await page.goto('http://first.invalid/')
    await expect(page.locator('p')).toHaveText('Routed page')
    await command({ command: 'activate', id: 'profile1' })
    await page.goto('http://second.invalid/')
    await expect(page.locator('p')).toHaveText('Routed page')
    expect(
      requests[0].some(
        req =>
          req.url.includes('first.invalid') &&
          req.auth === `Basic ${Buffer.from('user0:secret0').toString('base64')}`
      )
    ).toBe(true)
    expect(
      requests[1].some(
        req =>
          req.url.includes('second.invalid') &&
          req.auth === `Basic ${Buffer.from('user1:secret1').toString('base64')}`
      )
    ).toBe(true)
    expect(requests[0].some(req => req.url.includes('second.invalid'))).toBe(false)
    const tabs = await command({ command: 'testTabState' })
    const tab = tabs.tabs.find(tab => tab.url === 'http://second.invalid/')
    expect(tab.badge).toBe('')
    await expect
      .poll(
        async () =>
          (await command({ command: 'testTabState' })).tabs.find(item => item.id === tab.id).title
      )
      .toContain('Route1')
    await expect
      .poll(async () =>
        (await command({ command: 'network', tabId: tab.id })).entries.some(
          row => row.domain === 'missing.invalid' && row.failed
        )
      )
      .toBe(true)
    const rows = (await command({ command: 'network', tabId: tab.id })).entries
    expect(JSON.stringify(rows)).not.toContain('private')
    const configured = (await command({ command: 'get' })).state.browserRouting
    await command({
      command: 'routing',
      routing: { ...configured, strategy: 'manual', domains: ['second.invalid', 'missing.invalid'] }
    })
    const probe = await browser.context.newPage()
    await expect(probe.goto('http://first.invalid/', { timeout: 5000 })).rejects.toThrow()
    await probe.close()
    const assignedProbe = await browser.context.newPage()
    await assignedProbe.goto('http://second.invalid/')
    await expect(assignedProbe.locator('p')).toHaveText('Routed page')
    await assignedProbe.close()
    await command({
      command: 'addFailedDomains',
      tabId: tab.id,
      domains: ['missing.invalid'],
      profileId: 'profile1'
    })
    expect(
      (await command({ command: 'testRule', url: 'http://sub.missing.invalid/' })).profile.id
    ).toBe('profile1')
    await command({ command: 'connectionMode', mode: 'direct' })
    await page.goto(`http://127.0.0.1:${direct.address().port}/`)
    await expect(page.locator('body')).toHaveText('Direct page')
    expect((await command({ command: 'testRule', url: 'http://second.invalid/' })).proxied).toBe(
      false
    )
    await command({ command: 'connectionMode', mode: 'system' })
    await page.reload()
    await expect(page.locator('body')).toHaveText('Direct page')
    await expect
      .poll(
        async () =>
          (await command({ command: 'testTabState' })).tabs.find(item => item.id === tab.id).badge
      )
      .toBe('SYS')
    await command({ command: 'statistics', enabled: false })
    await page.reload()
    expect((await command({ command: 'network', tabId: tab.id })).entries).toEqual([])
    expect((await command({ command: 'get' })).statistics).toBeUndefined()
  } finally {
    await browser?.close()
    for (const server of [...servers, direct]) {
      server.closeAllConnections?.()
      await new Promise(resolve => server.close(resolve))
    }
    await rm(dir, { recursive: true, force: true })
  }
})

// eslint-disable-next-line no-empty-pattern
test('Direct bypasses a preconfigured external proxy and System restores it', async ({}, testInfo) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mega-system-'))
  const requests = []
  const proxy = http.createServer((req, res) => {
    requests.push(req.url)
    res.setHeader('Content-Type', 'text/html')
    res.end('<p>External proxy</p>')
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await launchExtension(testInfo.project.name, dir, {
      systemProxy: { host: '127.0.0.1', port: proxy.address().port }
    })
    const page = await browser.context.newPage()
    await page.goto('http://external.invalid/before')
    await expect(page.locator('p')).toHaveText('External proxy')
    await browser.command({ command: 'connectionMode', mode: 'direct' })
    await expect(page.goto('http://external.invalid/direct', { timeout: 5000 })).rejects.toThrow()
    expect(requests.some(url => url.includes('/direct'))).toBe(false)
    await browser.command({ command: 'connectionMode', mode: 'system' })
    await page.goto('http://external.invalid/restored')
    await expect(page.locator('p')).toHaveText('External proxy')
    expect(requests.some(url => url.includes('/restored'))).toBe(true)
  } finally {
    await browser?.close()
    proxy.closeAllConnections?.()
    await new Promise(resolve => proxy.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

// eslint-disable-next-line no-empty-pattern
test('installed Chrome popup sizes correctly and profile dragging saves through the background', async ({}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium',
    'Firefox does not expose extension pages to Playwright'
  )
  const dir = await mkdtemp(path.join(tmpdir(), 'mega-ui-installed-'))
  let browser
  try {
    browser = await launchExtension('chromium', dir)
    for (const name of ['First', 'Second']) {
      const result = await browser.command({
        command: 'save',
        profile: { name, type: 'HTTP', host: 'proxy.example', port: 8080 }
      })
      expect(result.ok).toBe(true)
    }
    const page = await browser.context.newPage()
    await page.goto(browser.popupURL.replace('popup.html', 'options.html'))
    await expect(page.locator('.profile')).toHaveCount(2)
    const handle = await page.locator('.profile-drag').last().boundingBox()
    const first = await page.locator('.profile').first().boundingBox()
    await page.mouse.move(handle.x + 20, handle.y + 20)
    await page.mouse.down()
    await page.mouse.move(first.x + 20, first.y + 5, { steps: 10 })
    await expect(page.locator('.profile').first()).toContainText('Second')
    await page.mouse.up()
    await expect
      .poll(async () => (await browser.command({ command: 'get' })).state.profiles[0].name)
      .toBe('Second')
    const selected = (await browser.command({ command: 'get' })).state.profiles[0]
    const activated = await browser.command({ command: 'activate', id: selected.id })
    expect(activated.ok).toBe(true)
    expect(activated.warning).toBeUndefined()
    expect(activated.state.connectionMode).toBe('proxy')
    const optionTabId = await page.evaluate(async () => (await chrome.tabs.getCurrent()).id)
    const optionTab = (await browser.command({ command: 'testTabState' })).tabs.find(
      tab => tab.id === optionTabId
    )
    expect(optionTab.badge).toBe('')
    expect(optionTab.title).toContain('Second')
    await page.locator('#routing-settings > summary').click()
    await expect(page.locator('#routing-form button[type=submit]')).toHaveCount(0)
    await page.locator('#routing-mode').selectOption('manual')
    await page.locator('#routing-list').fill('example.com')
    await page.locator('#routing-list').blur()
    await expect
      .poll(async () => (await browser.command({ command: 'get' })).state.browserRouting.domains)
      .toEqual(['example.com'])
    await page.locator('#routing-mode').selectOption('all')
    await expect
      .poll(async () => (await browser.command({ command: 'get' })).state.browserRouting.enabled)
      .toBe(false)
    const second = await browser.context.newPage()
    await second.goto(browser.popupURL.replace('popup.html', 'options.html'))
    const popup = await browser.context.newPage()
    await popup.goto(browser.popupURL)
    for (const [source, mode] of [
      [popup, 'direct'],
      [second, 'system'],
      [page, 'failover'],
      [popup, 'proxy']
    ]) {
      await source.locator('#connection-mode').selectOption(mode)
      for (const view of [page, second, popup]) {
        await expect(view.locator('#connection-mode')).toHaveValue(mode)
      }
    }
    await second.close()
    await popup.close()
    await browser.context.serviceWorkers()[0].evaluate(() => chrome.action.openPopup())
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const view = chrome.extension.getViews({ type: 'popup' })[0]
          if (!view || view.document.body.hidden) {
            return null
          }
          return {
            surface: view.document.documentElement.dataset.surface,
            width: view.innerWidth,
            visible:
              view.document.querySelector('.popup-content').getBoundingClientRect().height > 100,
            bounded: view.innerHeight <= 600
          }
        })
      )
      .toEqual({ surface: 'popup', width: 380, visible: true, bounded: true })
  } finally {
    await browser?.close()
    await rm(dir, { recursive: true, force: true })
  }
})

// eslint-disable-next-line no-empty-pattern
test('profile icons use their color, fade long names on the right and bound cached images', async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Pixel inspection uses the Chromium worker')
  const dir = await mkdtemp(path.join(tmpdir(), 'mega-icon-'))
  let browser
  try {
    browser = await launchExtension('chromium', dir)
    const result = await browser.context.serviceWorkers()[0].evaluate(async () => {
      const images = await profileIcon({ name: 'WWWWWWWWWWWW', host: 'proxy.example', color: 0 })
      const image = images[48]
      const reference = new OffscreenCanvas(48, 48)
      const ctx = reference.getContext('2d')
      const sample = (46 * 48 + 24) * 4
      const color = [...image.data.slice(sample, sample + 4)]
      ctx.fillStyle = `rgb(${color.slice(0, 3).join(',')})`
      ctx.fillRect(0, 0, 48, 48)
      ctx.scale(3, 3)
      ctx.font = 'bold 7.5px Arial, Helvetica, sans-serif'
      ctx.fillStyle = '#ffffff'
      ctx.fillText('WWWWWWWWWWWW', 1, 14.5)
      const plain = ctx.getImageData(0, 0, 48, 48)
      const ink = data => {
        let total = 0
        for (let y = 28; y < 44; y++) {
          for (let x = 34; x < 46; x++) {
            const index = (y * 48 + x) * 4
            total +=
              Math.abs(data[index] - color[0]) +
              Math.abs(data[index + 1] - color[1]) +
              Math.abs(data[index + 2] - color[2])
          }
        }
        return total
      }
      for (let index = 0; index < 35; index++) {
        await profileIcon({ name: `Profile ${index}`, host: 'proxy.example', color: 0 })
      }
      const prototype = Object.getPrototypeOf(new OffscreenCanvas(1, 1).getContext('2d'))
      const gradient = prototype.createLinearGradient
      const fillText = prototype.fillText
      let shortFades = 0
      const shortWidths = []
      prototype.createLinearGradient = function (...args) {
        shortFades++
        return gradient.apply(this, args)
      }
      prototype.fillText = function (...args) {
        shortWidths.push(this.measureText(args[0]).width)
        return fillText.apply(this, args)
      }
      let shortImages
      try {
        for (const name of ['AM', 'WW', 'ЖЯ']) {
          shortImages = await profileIcon({ name, host: 'proxy.example', color: 0 })
        }
      } finally {
        prototype.createLinearGradient = gradient
        prototype.fillText = fillText
      }
      const original = await createImageBitmap(
        await (await fetch(chrome.runtime.getURL('icons/toolbar48.png'))).blob()
      )
      ctx.resetTransform()
      ctx.clearRect(0, 0, 48, 48)
      ctx.drawImage(original, 0, 0)
      const top = ctx.getImageData(0, 0, 48, 24).data
      const topMatches = top.every((value, index) => value === shortImages[48].data[index])
      return {
        shortFades,
        shortWidths,
        topMatches,
        sizes: Object.keys(images).map(Number),
        color,
        faded: ink(image.data),
        plain: ink(plain.data),
        cached: profileIcons.size
      }
    })
    expect(result.sizes).toEqual([16, 24, 32, 48])
    expect(result.shortFades).toBe(0)
    expect(result.shortWidths).toHaveLength(12)
    expect(Math.max(...result.shortWidths)).toBeLessThanOrEqual(14.01)
    expect(result.topMatches).toBe(true)
    expect(result.color[0]).toBeGreaterThan(result.color[1] * 2)
    expect(result.color[3]).toBe(255)
    const luminance = result.color
      .slice(0, 3)
      .map(value => {
        const component = value / 255
        return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4
      })
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
    expect(1.05 / (luminance + 0.05)).toBeGreaterThanOrEqual(7)
    expect(result.plain).toBeGreaterThan(0)
    expect(result.faded).toBeLessThan(result.plain * 0.7)
    expect(result.cached).toBeLessThanOrEqual(32)
    const saved = await browser.command({
      command: 'save',
      profile: { name: 'Race', type: 'HTTP', host: 'proxy.example', port: 8080 }
    })
    await browser.command({ command: 'activate', id: saved.state.profiles[0].id })
    const final = await browser.context.serviceWorkers()[0].evaluate(async () => {
      const originalIcon = profileIcon
      const originalState = state
      let release, entered
      const blocked = new Promise(resolve => {
        release = resolve
      })
      const started = new Promise(resolve => {
        entered = resolve
      })
      const tabId = (await chrome.tabs.query({}))[0].id
      profileIcon = async profile => {
        entered()
        await blocked
        return originalIcon(profile)
      }
      try {
        const pending = updateBadge(tabId, 'about:blank')
        await started
        state = { ...state, activeId: null, connectionMode: 'direct' }
        await updateBadge(tabId, 'about:blank')
        release()
        await pending
        return {
          badge: await chrome.action.getBadgeText({ tabId }),
          title: await chrome.action.getTitle({ tabId })
        }
      } finally {
        release()
        profileIcon = originalIcon
        state = originalState
      }
    })
    expect(final).toEqual({ badge: 'DIR', title: 'MegaProxy · DIRECT' })
  } finally {
    await browser?.close()
    await rm(dir, { recursive: true, force: true })
  }
})
