/* global chrome, toolbarIcon: writable, toolbarIcons, updateBadge, state: writable */
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
    expect(tab.badge).toBe('!')
    expect((await command({ command: 'get' })).state.connectionUpdate.message).toBe(
      testInfo.project.name === 'chromium'
        ? 'connectionUpdatedChromium'
        : 'connectionUpdatedFirefox'
    )
    await command({ command: 'dismissConnectionUpdate' })
    await expect
      .poll(
        async () =>
          (await command({ command: 'testTabState' })).tabs.find(item => item.id === tab.id).badge
      )
      .toBe('')
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
    expect(
      (await command({ command: 'testTabState' })).tabs.find(item => item.id === tab.id).badge
    ).toBe('!')
    await command({ command: 'dismissConnectionUpdate' })
    await expect
      .poll(
        async () =>
          (await command({ command: 'testTabState' })).tabs.find(item => item.id === tab.id).badge
      )
      .toBe('')
    await expect
      .poll(
        async () =>
          (await command({ command: 'testTabState' })).tabs.find(item => item.id === tab.id).title
      )
      .toContain('SYSTEM')
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
            width: view.document.body.getBoundingClientRect().width,
            visible:
              view.document.querySelector('.popup-content').getBoundingClientRect().height > 100,
            bounded: view.innerHeight <= 600 && view.document.body.scrollWidth <= view.innerWidth
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
test('profile icons preserve the logo, show a colored dot and keep full names in tooltips', async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Pixel inspection uses the Chromium worker')
  const dir = await mkdtemp(path.join(tmpdir(), 'mega-icon-'))
  let browser
  try {
    browser = await launchExtension('chromium', dir)
    const result = await browser.context.serviceWorkers()[0].evaluate(async () => {
      const images = await toolbarIcon('#f44336')
      const reused = await toolbarIcon('#f44336')
      const other = await toolbarIcon('#e91e63')
      const direct = await toolbarIcon('#bdbdbd')
      const system = await toolbarIcon('#616161')
      const checks = []
      for (const [sizeText, image] of Object.entries(images)) {
        const size = Number(sizeText)
        const original = await createImageBitmap(
          await (await fetch(chrome.runtime.getURL(`icons/toolbar${size}.png`))).blob()
        )
        const ctx = new OffscreenCanvas(size, size).getContext('2d')
        ctx.drawImage(original, 0, 0)
        const base = ctx.getImageData(0, 0, size, size).data
        const center = Math.floor((13 * size) / 16)
        const index = (center * size + center) * 4
        checks.push({
          size,
          logoMatches: base.every((value, index) => {
            const pixel = Math.floor(index / 4)
            return (
              (pixel % size >= Math.floor((8 * size) / 16) &&
                Math.floor(pixel / size) >= Math.floor((8 * size) / 16)) ||
              value === image.data[index]
            )
          }),
          color: [...image.data.slice(index, index + 4)],
          otherColor: [...other[size].data.slice(index, index + 4)],
          rightBaseAlpha: base[(center * size + size - 1) * 4 + 3],
          rightDotAlpha: image.data[(center * size + size - 1) * 4 + 3],
          bottomBaseAlpha: base[((size - 1) * size + center) * 4 + 3],
          bottomDotAlpha: image.data[((size - 1) * size + center) * 4 + 3]
        })
      }
      const pixel = (x, y) => [...images[48].data.slice((y * 48 + x) * 4, (y * 48 + x) * 4 + 4)]
      return {
        checks,
        reused: images === reused,
        cached: toolbarIcons.size,
        direct: [...direct[64].data.slice((50 * 64 + 50) * 4, (50 * 64 + 50) * 4 + 4)],
        system: [...system[64].data.slice((50 * 64 + 50) * 4, (50 * 64 + 50) * 4 + 4)],
        separator: pixel(33, 26),
        whiteOutline: pixel(46, 37)
      }
    })
    expect(result.checks.map(check => check.size)).toEqual([16, 24, 32, 48, 64])
    for (const check of result.checks) {
      expect(check.logoMatches).toBe(true)
      expect(check.color).toEqual([244, 67, 54, 255])
      expect(check.otherColor).toEqual([233, 30, 99, 255])
      expect(check.rightBaseAlpha).toBe(0)
      expect(check.bottomBaseAlpha).toBe(0)
      expect(check.rightDotAlpha).toBeGreaterThan(0)
      expect(check.bottomDotAlpha).toBeGreaterThan(0)
    }
    expect(result.reused).toBe(true)
    expect(result.separator).toEqual([0, 0, 0, 0])
    expect(result.whiteOutline).toEqual([255, 255, 255, 255])
    expect(result.cached).toBeLessThanOrEqual(14)
    expect(result.direct).toEqual([189, 189, 189, 255])
    expect(result.system).toEqual([97, 97, 97, 255])
    const name = 'Рабочая прокси Германия — полное длинное название подключения'
    const saved = await browser.command({
      command: 'save',
      profile: { name, type: 'HTTP', host: 'proxy.example', port: 8080 }
    })
    await browser.command({ command: 'activate', id: saved.state.profiles[0].id })
    const active = await browser.context.serviceWorkers()[0].evaluate(async () => {
      const tabId = (await chrome.tabs.query({}))[0].id
      await updateBadge(tabId, 'about:blank')
      return {
        badge: await chrome.action.getBadgeText({ tabId }),
        title: await chrome.action.getTitle({ tabId })
      }
    })
    expect(active).toEqual({ badge: '', title: `MegaProxy · ${name}\nHTTP · proxy.example:8080` })
    const modes = await browser.context.serviceWorkers()[0].evaluate(async () => {
      const originalState = state
      const originalIcon = toolbarIcon
      const colors = []
      const modes = []
      toolbarIcon = color => {
        colors.push(color)
        return originalIcon(color)
      }
      try {
        const tabId = (await chrome.tabs.query({}))[0].id
        for (const connectionMode of ['direct', 'system']) {
          state = { ...state, connectionMode }
          await updateBadge(tabId, 'about:blank')
          modes.push({
            badge: await chrome.action.getBadgeText({ tabId }),
            title: await chrome.action.getTitle({ tabId })
          })
        }
        return { colors, modes }
      } finally {
        state = originalState
        toolbarIcon = originalIcon
      }
    })
    expect(modes).toEqual({
      colors: ['#bdbdbd', '#616161'],
      modes: [
        { badge: '', title: 'MegaProxy · DIRECT' },
        { badge: '', title: 'MegaProxy · SYSTEM' }
      ]
    })
    const final = await browser.context.serviceWorkers()[0].evaluate(async () => {
      const originalIcon = toolbarIcon
      const originalState = state
      let release, entered
      const blocked = new Promise(resolve => {
        release = resolve
      })
      const started = new Promise(resolve => {
        entered = resolve
      })
      const tabId = (await chrome.tabs.query({}))[0].id
      let first = true
      toolbarIcon = async color => {
        if (first) {
          first = false
          entered()
          await blocked
        }
        return originalIcon(color)
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
        toolbarIcon = originalIcon
        state = originalState
      }
    })
    expect(final).toEqual({ badge: '', title: 'MegaProxy · DIRECT' })
  } finally {
    await browser?.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('installed popup reuses the current window settings tab for each scenario', async ({
  browserName
}) => {
  test.skip(browserName !== 'chromium', 'Firefox does not expose extension pages to Playwright')
  const dir = await mkdtemp(path.join(tmpdir(), 'mega-settings-tab-'))
  let browser
  try {
    browser = await launchExtension(browserName, dir)
    const settings = await browser.context.newPage()
    await settings.goto(browser.popupURL.replace('popup.html', 'options.html'))
    await expect(settings.locator('body')).toBeVisible()
    const popup = await browser.context.newPage()
    await popup.goto(browser.popupURL)
    await expect(popup.locator('#empty')).toBeVisible()
    const tabCount = browser.context.pages().length
    await popup.locator('#add-profile').click()
    await expect(settings.locator('#editor')).toBeVisible()
    await settings.locator('[name=name]').fill('Unsaved profile')
    await popup.bringToFront()
    await popup.locator('#add-profile').click()
    await expect(settings.locator('[name=name]')).toHaveValue('Unsaved profile')
    await settings.locator('#cancel-profile').click()
    await popup.bringToFront()
    await popup.locator('#import-config').click()
    await expect(settings.locator('#import-start')).toBeVisible()
    await settings.locator('#cancel-import-start').click()
    await popup.bringToFront()
    await popup.locator('#open-settings').click()
    expect(browser.context.pages()).toHaveLength(tabCount)
  } finally {
    await browser?.close()
    await rm(dir, { recursive: true, force: true })
  }
})
