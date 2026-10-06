/* global chrome, handle */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { chromium } from '@playwright/test'
import { networkDiagnostics } from './megaproxy-server/fixture.mjs'

const exec = promisify(execFile)
const output = path.resolve('test-results/android-vivaldi')
await mkdir(output, { recursive: true })
const adb = (...args) =>
  exec(process.env.ADB || 'adb', ['-s', process.env.ANDROID_SERIAL || 'emulator-5554', ...args], {
    timeout: 60000,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'buffer'
  })
const packageId = 'com.vivaldi.browser'
const nativeUI = async () => {
  await adb('shell', 'rm', '-f', '/sdcard/megaproxy-ui.xml')
  await adb('shell', 'uiautomator', 'dump', '/sdcard/megaproxy-ui.xml').catch(error => {
    // Android can kill the Java dump process after it has successfully written XML.
    if (
      error.code !== 137 ||
      !error.stdout?.toString().includes('UI hierchary dumped to: /sdcard/megaproxy-ui.xml')
    ) {
      throw error
    }
  })
  return (await adb('shell', 'cat', '/sdcard/megaproxy-ui.xml')).stdout.toString()
}
const tapText = async (xml, text) => {
  const node = xml.match(
    new RegExp(
      `<node[^>]*(?:text|content-desc)="${text}[^"]*"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`
    )
  )
  if (!node) {
    return false
  }
  const [, left, top, right, bottom] = node.map(Number)
  await adb('shell', 'input', 'tap', String((left + right) / 2), String((top + bottom) / 2))
  return true
}

const requests = []
const layouts = []
const completed = []
const servers = []
const tunnels = new Set()
const ports = []
let browser, worker
const snapshotNetwork = async phase => {
  const device = []
  for (const args of [
    ['ip', 'address'],
    ['ip', 'route'],
    ['ip', '-6', 'route'],
    ['ss', '-tan']
  ]) {
    const result = await adb('shell', ...args).catch(error => ({
      stdout: error.stdout || '',
      stderr: error.stderr || error.message
    }))
    device.push(`adb shell ${args.join(' ')}\n${result.stdout}${result.stderr || ''}`)
  }
  await writeFile(
    `${output}/network-${phase}.txt`,
    `${new Date().toISOString()}\n${await networkDiagnostics()}\nAndroid network\n${device.join('\n')}`
  )
}
const listen = async handler => {
  const server = http.createServer(handler)
  servers.push(server)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  ports.push(port)
  await adb('reverse', `tcp:${port}`, `tcp:${port}`)
  return port
}
const poll = async (condition, description) => {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (await condition()) {
      return
    }
    await delay(200)
  }
  throw new Error(`Timed out: ${description}`)
}
const command = async message => {
  const result = await worker.evaluate(async message => {
    if (message.command === 'testVisit') {
      const tab = globalThis.testTabId
        ? await chrome.tabs.update(globalThis.testTabId, { url: message.url })
        : await chrome.tabs.create({ url: message.url })
      globalThis.testTabId = tab.id
      return { ok: true, tab }
    }
    if (message.command === 'testCompleted') {
      return { ok: true, completed: globalThis.testCompleted }
    }
    return handle(message)
  }, message)
  assert.equal(result.ok, true, result.error)
  return result
}

try {
  assert.equal(
    (await adb('shell', 'getprop', 'ro.kernel.qemu')).stdout.toString().trim(),
    '1',
    'Use a disposable Android emulator, never a personal device'
  )
  await poll(async () => {
    await adb('wait-for-device')
    if ((await adb('shell', 'id', '-u')).stdout.toString().trim() === '0') {
      return true
    }
    await adb('root').catch(error => {
      if (!error.stderr?.toString().includes('unable to connect for root: closed')) {
        throw error
      }
    })
    return false
  }, 'ADB daemon restarted with root privileges')
  await snapshotNetwork('start')
  await adb('logcat', '-c')
  await adb('shell', 'settings', 'put', 'global', 'adb_enabled', '1')
  // The Google APIs image's launcher can ANR after snapshot restore; it is unused here.
  const launcher = 'com.google.android.apps.nexuslauncher'
  if (
    (await adb('shell', 'pm', 'list', 'packages', launcher)).stdout.toString().includes(launcher)
  ) {
    await adb('shell', 'pm', 'disable-user', '--user', '0', launcher)
  }
  await adb('install', '-r', process.env.VIVALDI_ANDROID_APK || '.cache/vivaldi-android.apk')
  await adb('shell', 'pm', 'clear', packageId)
  await adb('shell', 'pm', 'grant', packageId, 'android.permission.POST_NOTIFICATIONS')
  await adb('shell', 'am', 'set-debug-app', '--persistent', packageId)
  const activity = (
    await adb(
      'shell',
      'cmd',
      'package',
      'resolve-activity',
      '--brief',
      '-a',
      'android.intent.action.MAIN',
      '-c',
      'android.intent.category.LAUNCHER',
      '-p',
      packageId
    )
  ).stdout
    .toString()
    .trim()
    .split('\n')
    .at(-1)
  assert.ok(activity.startsWith(`${packageId}/`), `Vivaldi launch activity not found: ${activity}`)
  const flags =
    '_ --disable-fre --no-first-run --no-default-browser-check --remote-debugging-socket-name=megaproxy_devtools_remote --load-extension=/data/data/com.vivaldi.browser/files/megaproxy --ignore-certificate-errors'
  await writeFile(`${output}/chrome-command-line`, flags)
  await adb('push', `${output}/chrome-command-line`, '/data/local/tmp/chrome-command-line')
  await adb(
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    'about:blank',
    '-n',
    activity
  )
  await poll(
    async () =>
      (
        await adb('shell', 'ls', `/data/data/${packageId}/files`).catch(() => ({
          stdout: Buffer.alloc(0)
        }))
      ).stdout.length > 0,
    'Vivaldi private profile creation'
  )
  await adb('shell', 'am', 'force-stop', packageId)
  await adb('shell', 'rm', '-rf', '/data/local/tmp/megaproxy')
  await adb('push', 'dist/chromium', '/data/local/tmp/megaproxy')
  // ADB push preserves restrictive directory modes. App ownership and SELinux labels
  // are necessary for Chromium to enumerate _locales and read the production build.
  await adb(
    'shell',
    `rm -rf /data/data/${packageId}/files/megaproxy; cp -r /data/local/tmp/megaproxy /data/data/${packageId}/files/megaproxy; chown -R $(stat -c %u:%g /data/data/${packageId}/files) /data/data/${packageId}/files/megaproxy; restorecon -R /data/data/${packageId}/files/megaproxy`
  )
  await adb(
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    'about:blank',
    '-n',
    activity
  )
  await poll(
    async () =>
      (await adb('shell', 'cat', '/proc/net/unix')).stdout
        .toString()
        .includes('@megaproxy_devtools_remote'),
    'Vivaldi CDP socket'
  )
  await adb('forward', 'tcp:9222', 'localabstract:megaproxy_devtools_remote')
  browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  const context = browser.contexts()[0]
  worker =
    context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://')) ||
    (await context.waitForEvent('serviceworker', {
      predicate: w => w.url().startsWith('chrome-extension://'),
      timeout: 30000
    }))
  const extensionId = new URL(worker.url()).host
  await worker.evaluate(() => {
    globalThis.testCompleted = []
    globalThis.testCreated = []
    chrome.tabs.onCreated.addListener(tab =>
      globalThis.testCreated.push({ id: tab.id, active: tab.active })
    )
    chrome.webRequest.onCompleted.addListener(
      d =>
        globalThis.testCompleted.push({
          url: d.url,
          type: d.type,
          statusCode: d.statusCode,
          tabId: d.tabId,
          fromCache: d.fromCache
        }),
      { urls: ['<all_urls>'] }
    )
  })
  const versionPage = await context.newPage()
  await versionPage.goto('chrome://version')
  const version = await versionPage.locator('body').innerText()
  assert.ok(version.includes('--load-extension=/data/data/com.vivaldi.browser/files/megaproxy'))
  await writeFile(`${output}/version.txt`, version)
  const directPort = await listen((req, res) => {
    requests.push({ route: 'direct', url: req.url })
    res.end('MegaProxy Android direct OK')
  })
  await exec('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    `${output}/test-key.pem`,
    '-out',
    `${output}/test-cert.pem`,
    '-days',
    '1',
    '-subj',
    '/CN=knock.megaproxy.test'
  ])
  let knockStatus = 200
  const tlsOrigin = https.createServer(
    {
      key: await readFile(`${output}/test-key.pem`),
      cert: await readFile(`${output}/test-cert.pem`)
    },
    (req, res) => {
      requests.push({ route: 'knock', url: req.url, statusCode: knockStatus })
      // The next scenario changes this same URL from success to failure.
      res.writeHead(knockStatus, { 'Cache-Control': 'no-store' }).end('Knock response')
    }
  )
  servers.push(tlsOrigin)
  await new Promise(resolve => tlsOrigin.listen(0, '127.0.0.1', resolve))
  const proxyPort = await listen((req, res) => {
    const authenticated =
      req.headers['proxy-authorization'] ===
      `Basic ${Buffer.from('mobile-user:mobile-test-password').toString('base64')}`
    requests.push({ route: 'proxy', url: req.url, authenticated })
    if (!authenticated) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="MegaProxy Android test"' })
      res.end('Authentication required')
    } else if (new URL(req.url).pathname === '/image.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' })
      res.end(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
          'base64'
        )
      )
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(
        `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><h1>MegaProxy Android proxy OK</h1><img src="http://third.mobile.invalid/image.png?from=${encodeURIComponent(new URL(req.url).pathname)}">`
      )
    }
  })
  const proxyServer = servers.at(-1)
  proxyServer.on('connect', (req, socket, head) => {
    const authenticated =
      req.headers['proxy-authorization'] ===
      `Basic ${Buffer.from('mobile-user:mobile-test-password').toString('base64')}`
    requests.push({ route: 'connect', url: req.url, authenticated })
    if (!authenticated) {
      socket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="MegaProxy Android test"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
      )
      return
    }
    if (req.url !== 'knock.megaproxy.test:443') {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      return
    }
    const upstream = net.connect(tlsOrigin.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) {
        upstream.write(head)
      }
      socket.pipe(upstream).pipe(socket)
    })
    for (const connection of [socket, upstream]) {
      tunnels.add(connection)
      connection.on('close', () => tunnels.delete(connection))
      connection.on('error', () => {
        socket.destroy()
        upstream.destroy()
      })
    }
  })
  await command({ command: 'sync', enabled: false, includePasswords: false })
  await command({
    command: 'save',
    profile: {
      id: 'mobile-test',
      name: 'Mobile test',
      type: 'http',
      host: '127.0.0.1',
      port: proxyPort,
      username: 'mobile-user',
      password: 'mobile-test-password',
      bypass: ['127.0.0.1']
    }
  })
  await command({ command: 'activate', id: 'mobile-test' })
  await command({ command: 'bypassLocalNetworks', enabled: false })
  const visit = async url => {
    await command({ command: 'testVisit', url })
    await poll(async () => {
      const result = await command({ command: 'testCompleted' })
      completed.splice(0, completed.length, ...result.completed)
      return completed.some(r => r.url === url && r.type === 'main_frame' && r.statusCode === 200)
    }, `browser document load: ${url}`)
  }
  await visit('http://mobile.megaproxy.test/auth')
  assert.ok(requests.some(r => r.url === 'http://mobile.megaproxy.test/auth' && r.authenticated))
  console.log('PASS: saved credentials and authenticated HTTP proxy load')
  const createdBeforeKnock = await worker.evaluate(() => globalThis.testCreated.length)
  const profile = (await command({ command: 'get' })).state.profiles.find(
    p => p.id === 'mobile-test'
  )
  await command({ command: 'save', profile: { ...profile, knockHost: 'knock.megaproxy.test' } })
  await poll(async () => {
    const { completed } = await command({ command: 'testCompleted' })
    const tabs = await worker.evaluate(() => chrome.tabs.query({}))
    return (
      completed.some(
        r =>
          r.url === 'https://knock.megaproxy.test/' &&
          r.type === 'main_frame' &&
          r.statusCode === 200
      ) &&
      !tabs.some(
        t =>
          t.url?.includes('knock.megaproxy.test') || t.pendingUrl?.includes('knock.megaproxy.test')
      )
    )
  }, 'authenticated knock succeeds and closes its tab')
  assert.ok(requests.some(r => r.route === 'connect' && r.authenticated))
  const knockCreated = await worker.evaluate(
    offset => globalThis.testCreated.slice(offset),
    createdBeforeKnock
  )
  assert.equal(knockCreated.length, 1, 'Activation opens exactly one knock tab')
  assert.equal(knockCreated[0].active, false)
  console.log('PASS: authenticated HTTPS knock opens inactive and closes after success')
  knockStatus = 500
  await command({ command: 'knock' })
  let failedKnock
  await poll(async () => {
    const { completed } = await command({ command: 'testCompleted' })
    failedKnock = (await worker.evaluate(() => chrome.tabs.query({}))).find(
      t => t.url === 'https://knock.megaproxy.test/'
    )
    return (
      failedKnock &&
      completed.some(
        r =>
          r.tabId === failedKnock.id &&
          r.type === 'main_frame' &&
          r.url === 'https://knock.megaproxy.test/' &&
          r.statusCode === 500 &&
          !r.fromCache
      )
    )
  }, 'failed knock remains open')
  assert.equal(failedKnock.active, false)
  await worker.evaluate(id => chrome.tabs.remove(id), failedKnock.id)
  console.log('PASS: failed knock stays open and inactive')
  await command({
    command: 'routing',
    routing: { enabled: true, mode: 'domains', domains: ['**.megaproxy.test'] }
  })
  await visit('http://child.megaproxy.test/domains')
  await visit(`http://localhost:${directPort}/excluded`)
  assert.ok(requests.some(r => r.route === 'direct' && r.url === '/excluded'))
  assert.ok(!requests.some(r => r.route === 'proxy' && r.url.includes('/excluded')))
  console.log('PASS: manual domains include subdomains and exclude other sites')
  for (const mode of ['direct', 'system']) {
    await command({ command: 'connectionMode', mode })
    await visit(`http://localhost:${directPort}/${mode}`)
    assert.ok(requests.some(r => r.route === 'direct' && r.url === `/${mode}`))
    console.log(`PASS: ${mode} connection mode`)
  }
  await adb(
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    `http://localhost:${directPort}/native-ui`,
    '-p',
    packageId
  )
  for (const label of ['Extensions', 'MegaProxy']) {
    await poll(async () => tapText(await nativeUI(), label), `Native control: ${label}`)
  }
  await poll(async () => {
    const xml = await nativeUI()
    return xml.includes('Settings') && xml.includes('Mobile test')
  }, 'native Vivaldi popup shows its profile and settings')
  const nativeSession = await browser.newBrowserCDPSession()
  const { targetInfos } = await nativeSession.send('Target.getTargets')
  const target = targetInfos.find(
    t => t.type === 'other' && t.url === `chrome-extension://${extensionId}/popup.html`
  )
  assert.ok(target, 'Native action popup target exists')
  const socket = new WebSocket(`ws://127.0.0.1:9222/devtools/page/${target.targetId}`)
  const nativeLayout = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native popup layout timed out')), 15000)
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('Native popup CDP failed'))
    })
    socket.addEventListener('open', () =>
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression: `JSON.stringify({surface:document.documentElement.dataset.surface,width:innerWidth,height:innerHeight,mainHeight:document.querySelector('main').getBoundingClientRect().height,contentHeight:document.querySelector('.popup-content').clientHeight,scrollHeight:document.querySelector('.popup-content').scrollHeight,profileTop:document.querySelector('.profile').getBoundingClientRect().top})`,
            returnByValue: true
          }
        })
      )
    )
    socket.addEventListener('message', event => {
      const result = JSON.parse(event.data)
      if (result.id === 1) {
        clearTimeout(timer)
        result.error
          ? reject(new Error(result.error.message))
          : resolve(JSON.parse(result.result.result.value))
      }
    })
  }).finally(() => socket.close())
  assert.ok(['tab', 'popup'].includes(nativeLayout.surface))
  assert.ok(
    nativeLayout.height > 200 && nativeLayout.contentHeight > 200,
    `Native popup is clipped: ${JSON.stringify(nativeLayout)}`
  )
  assert.ok(nativeLayout.mainHeight <= nativeLayout.height + 1)
  assert.ok(nativeLayout.profileTop < nativeLayout.height)
  layouts.push({ page: 'native-popup', ...nativeLayout })
  await writeFile(`${output}/native-popup.png`, (await adb('exec-out', 'screencap', '-p')).stdout)
  assert.ok(await tapText(await nativeUI(), 'Settings'), 'Native popup settings action')
  await poll(
    () => context.pages().some(p => p.url() === `chrome-extension://${extensionId}/options.html`),
    'native popup opens options'
  )
  console.log('PASS: native Vivaldi popup opens extension settings')
  for (const name of ['popup', 'options']) {
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/${name}.html`)
    await page.locator('#connection-mode').waitFor()
    const layout = await page.evaluate(() => ({
      page: location.pathname,
      width: innerWidth,
      content: document.documentElement.scrollWidth,
      settingsRight: document.querySelector('#open-settings')?.getBoundingClientRect().right
    }))
    layouts.push(layout)
    assert.ok(
      layout.width > 0 && layout.width <= 420,
      `Unexpected mobile viewport: ${layout.width}`
    )
    assert.ok(layout.content <= layout.width, `${name} overflows: ${JSON.stringify(layout)}`)
    if (name === 'popup') {
      assert.ok(layout.settingsRight <= layout.width)
    }
    await page.screenshot({ path: `${output}/${name}.png` })
    console.log(`PASS: ${name} fits the Android viewport`)
  }
  await writeFile(
    `${output}/results.json`,
    JSON.stringify({ layouts, requests, completed }, null, 2)
  )
} finally {
  await snapshotNetwork('end').catch(() => {})
  await writeFile(`${output}/requests.json`, JSON.stringify(requests, null, 2))
  if (worker) {
    await worker
      .evaluate(() => ({ completed: globalThis.testCompleted, created: globalThis.testCreated }))
      .then(events => writeFile(`${output}/browser-events.json`, JSON.stringify(events, null, 2)))
      .catch(() => {})
  }
  await adb('exec-out', 'screencap', '-p')
    .then(r => writeFile(`${output}/final.png`, r.stdout))
    .catch(() => {})
  await nativeUI()
    .then(xml => writeFile(`${output}/final.xml`, xml))
    .catch(() => {})
  await adb('logcat', '-d')
    .then(r => writeFile(`${output}/logcat.txt`, r.stdout))
    .catch(() => {})
  for (const port of ports) {
    await adb('reverse', '--remove', `tcp:${port}`).catch(() => {})
  }
  await browser?.close().catch(() => {})
  await adb('shell', 'am', 'force-stop', packageId).catch(() => {})
  await adb('shell', 'am', 'clear-debug-app').catch(() => {})
  await adb('shell', 'rm', '-f', '/data/local/tmp/chrome-command-line').catch(() => {})
  await adb('forward', '--remove', 'tcp:9222').catch(() => {})
  for (const socket of tunnels) {
    socket.destroy()
  }
  for (const server of servers) {
    server.closeAllConnections()
    server.close()
  }
}
