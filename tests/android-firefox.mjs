import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { installFirefoxAddon } from '../scripts/firefox-addon.mjs'

const exec = promisify(execFile)
const output = path.resolve('test-results/android-firefox')
await mkdir(output, { recursive: true })
const adb = (...args) =>
  exec(process.env.ADB || 'adb', ['-s', process.env.ANDROID_SERIAL || 'emulator-5554', ...args], {
    timeout: 60000,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'buffer'
  })
const packageId = 'org.mozilla.firefox'
const nativeUI = async () => {
  await adb('shell', 'uiautomator', 'dump', '/sdcard/megaproxy-ui.xml')
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
const ports = []
let waiting, pending
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
  await poll(() => waiting, 'test bridge connection')
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Command timed out: ${message.command}`)),
      15000
    )
    pending = result => {
      clearTimeout(timer)
      result.ok ? resolve(result) : reject(new Error(result.error))
    }
    waiting.end(JSON.stringify(message))
    waiting = null
  })
}

try {
  assert.equal(
    (await adb('shell', 'getprop', 'ro.kernel.qemu')).stdout.toString().trim(),
    '1',
    'Use a disposable Android emulator, never a personal device'
  )
  await adb('root')
  await adb('wait-for-device')
  await adb('install', '-r', process.env.FIREFOX_ANDROID_APK || '.cache/firefox-android.apk')
  await adb('shell', 'pm', 'clear', packageId)
  await adb(
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    'https://example.com',
    '-p',
    packageId
  )
  // Root access is confined to a disposable emulator; seed remote debugging and addon permissions.
  await poll(async () => {
    const { stdout } = await adb(
      'shell',
      'find',
      `/data/data/${packageId}/files/mozilla`,
      '-name',
      'prefs.js'
    ).catch(() => ({ stdout: Buffer.alloc(0) }))
    return stdout.toString().includes('prefs.js')
  }, 'Firefox profile creation')
  await adb('shell', 'am', 'force-stop', packageId)
  const { stdout: profileFiles } = await adb(
    'shell',
    'find',
    `/data/data/${packageId}/files/mozilla`,
    '-name',
    'prefs.js'
  )
  const profile = path.posix.dirname(profileFiles.toString().trim().split('\n')[0])
  assert.match(profile, /^\/data\/data\/org\.mozilla\.firefox\/files\/mozilla\/[\w.-]+$/)
  const prefs =
    '<map><boolean name="pref_key_terms_accepted" value="true"/><boolean name="pref_key_is_first_run" value="false"/><boolean name="pref_key_remote_debugging" value="true"/><long name="pref_key_onboarding_completed_timestamp" value="1"/></map>'
  await writeFile(`${output}/fenix_preferences.xml`, prefs)
  await writeFile(
    `${output}/user.js`,
    'user_pref("devtools.debugger.remote-enabled", true);\nuser_pref("devtools.debugger.prompt-connection", false);\n'
  )
  await writeFile(
    `${output}/extension-preferences.json`,
    JSON.stringify({
      'browser-mega-proxy@andre487': {
        permissions: ['internal:privateBrowsingAllowed'],
        origins: ['<all_urls>']
      }
    })
  )
  for (const [source, destination] of [
    ['fenix_preferences.xml', `/data/data/${packageId}/shared_prefs/fenix_preferences.xml`],
    ['user.js', `${profile}/user.js`],
    ['extension-preferences.json', `${profile}/extension-preferences.json`]
  ]) {
    await adb('push', `${output}/${source}`, '/data/local/tmp/megaproxy-pref')
    await adb(
      'shell',
      `rm -f '${destination}.bak'; cp /data/local/tmp/megaproxy-pref '${destination}'; chown $(stat -c %u:%g '${profile}') '${destination}'; chmod 600 '${destination}'`
    )
  }
  await adb(
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    'https://example.com',
    '-p',
    packageId
  )
  await poll(
    async () =>
      (await adb('shell', 'cat', '/proc/net/unix')).stdout
        .toString()
        .includes(`${packageId}/firefox-debugger-socket`),
    'Firefox remote debugger'
  )

  for (let i = 0; i < 8; i++) {
    const xml = await nativeUI()
    if (!/Welcome to Firefox|Open all your links|Set Firefox as your default/.test(xml)) {
      break
    }
    let tapped = false
    for (const label of ['Cancel', 'Not now', 'Continue']) {
      if (await tapText(xml, label)) {
        tapped = true
        break
      }
    }
    if (!tapped) {
      break
    }
  }

  const controlPort = await listen(async (req, res) => {
    if (req.method !== 'POST') {
      waiting = res
      res.on('close', () => {
        if (waiting === res) {
          waiting = null
        }
      })
      return
    }
    let body = ''
    for await (const chunk of req) {
      body += chunk
    }
    const result = JSON.parse(body)
    if (req.url === '/layout') {
      layouts.push(result)
    } else {
      pending?.(result)
      pending = null
    }
    res.end('ok')
  })
  const directPort = await listen((req, res) => {
    requests.push({ route: 'direct', url: req.url })
    res.end('MegaProxy Android direct OK')
  })
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
  const addon = `${output}/addon`
  await cp('dist/firefox', addon, { recursive: true })
  const manifest = JSON.parse(await readFile(`${addon}/manifest.json`, 'utf8'))
  manifest.background.scripts.push('test-bridge.js')
  await writeFile(`${addon}/manifest.json`, JSON.stringify(manifest))
  await writeFile(
    `${addon}/test-bridge.js`,
    `
    const testCompleted = []
    api.webRequest.onCompleted.addListener(d => testCompleted.push({url:d.url,type:d.type,statusCode:d.statusCode}), {urls:['<all_urls>']})
    ;(async () => {
      while (true) {
        try {
          const message = await (await fetch('http://127.0.0.1:${controlPort}/')).json()
          let result
          try {
            if (message.command === 'testVisit') result = {ok:true,tab:await api.tabs.create({url:message.url})}
            else if (message.command === 'testCompleted') result = {ok:true,completed:testCompleted}
            else if (message.command === 'testPlatform') result = {ok:true,platform:await api.runtime.getPlatformInfo(),privateAccess:await api.extension.isAllowedIncognitoAccess()}
            else result = await handle(message)
          } catch (error) { result = {ok:false,error:error.message} }
          await fetch('http://127.0.0.1:${controlPort}/', {method:'POST',body:JSON.stringify(result)})
        } catch { await new Promise(resolve => setTimeout(resolve,200)) }
      }
    })()
  `
  )
  await writeFile(
    `${addon}/test-layout.js`,
    `
    ;(async () => {
      for(let i=0;i<200 && (!innerWidth || (location.pathname==='/popup.html' && !document.documentElement.dataset.surface));i++) await new Promise(resolve=>setTimeout(resolve,100))
      await new Promise(resolve=>setTimeout(resolve,1000))
      await fetch('http://127.0.0.1:${controlPort}/layout', {method:'POST',body:JSON.stringify({page:location.pathname,width:innerWidth,content:document.documentElement.scrollWidth,settingsRight:document.querySelector('#open-settings')?.getBoundingClientRect().right})})
    })()
  `
  )
  for (const page of ['popup', 'options']) {
    const html = await readFile(`${addon}/${page}.html`, 'utf8')
    await writeFile(
      `${addon}/${page}.html`,
      html.replace('</body>', '<script src="test-layout.js"></script></body>')
    )
  }
  await exec('zip', ['-qr', `${output}/addon.xpi`, '.'], { cwd: addon })
  await adb('push', `${output}/addon.xpi`, '/data/local/tmp/megaproxy-android.xpi')
  await adb('forward', 'tcp:6000', `localabstract:${packageId}/firefox-debugger-socket`)
  await installFirefoxAddon(6000, '/data/local/tmp/megaproxy-android.xpi', { wake: true })
  await tapText(await nativeUI(), 'OK')
  const capabilities = await command({ command: 'testPlatform' })
  assert.equal(capabilities.platform.os, 'android')
  assert.equal(capabilities.privateAccess, true)
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
  await command({
    command: 'routing',
    routing: { enabled: true, mode: 'domains', domains: ['**.megaproxy.test'] }
  })
  await visit('http://child.megaproxy.test/domains')
  await visit(`http://localhost:${directPort}/excluded`)
  assert.ok(requests.some(r => r.route === 'direct' && r.url === '/excluded'))
  assert.ok(!requests.some(r => r.route === 'proxy' && r.url.includes('/excluded')))
  console.log('PASS: manual domains include subdomains and exclude other sites')
  const imagesBefore = completed.filter(r =>
    r.url.startsWith('http://third.mobile.invalid/image.png')
  ).length
  await command({
    command: 'routing',
    routing: { enabled: true, mode: 'tabs', sites: ['**.megaproxy.test'] }
  })
  await visit('http://child.megaproxy.test/tabs')
  await poll(
    async () =>
      (await command({ command: 'testCompleted' })).completed.filter(
        r => r.url.startsWith('http://third.mobile.invalid/image.png') && r.statusCode === 200
      ).length > imagesBefore,
    'third-party image follows the proxied tab'
  )
  assert.ok(
    requests.some(
      r => r.authenticated && r.url === 'http://third.mobile.invalid/image.png?from=%2Ftabs'
    )
  )
  console.log('PASS: tab routing proxies third-party resources')
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
  for (const page of ['popup', 'options']) {
    if (page === 'popup') {
      for (const label of ['More options', 'Extensions', 'MegaProxy']) {
        await poll(async () => {
          const xml = await nativeUI()
          // Dismiss emulator/onboarding overlays, never an ANR from Firefox itself.
          if (xml.includes('Pixel Launcher') && xml.includes('responding')) {
            await tapText(xml, 'Close app')
            return false
          }
          if (xml.includes('Set Firefox as your default')) {
            await tapText(xml, 'Cancel')
            return false
          }
          if (xml.includes('MegaProxy was added')) {
            await tapText(xml, 'OK')
            return false
          }
          return tapText(xml, label)
        }, `Native control: ${label}`)
      }
    } else {
      await poll(async () => tapText(await nativeUI(), 'Settings'), 'Popup settings action')
    }
    await poll(async () => {
      if (layouts.some(r => r.page === `/${page}.html`)) {
        return true
      }
      // Some Fenix versions leave the action activity over the new options tab.
      // Never press Back after options have already replaced that activity.
      if (page === 'options' && (await nativeUI()).includes('content-desc="Navigate up"')) {
        await adb('shell', 'input', 'keyevent', '4')
      }
      return false
    }, `${page} mobile layout report`)
    const layout = layouts.find(r => r.page === `/${page}.html`)
    assert.ok(
      layout.width > 0 && layout.width <= 420,
      `Unexpected mobile viewport: ${layout.width}`
    )
    assert.ok(layout.content <= layout.width, `${page} overflows: ${JSON.stringify(layout)}`)
    if (page === 'popup') {
      assert.ok(layout.settingsRight <= layout.width)
    }
    await writeFile(`${output}/${page}.png`, (await adb('exec-out', 'screencap', '-p')).stdout)
    console.log(`PASS: ${page} fits the Android viewport`)
  }
  await writeFile(
    `${output}/results.json`,
    JSON.stringify({ capabilities, layouts, requests, completed }, null, 2)
  )
} finally {
  await writeFile(`${output}/requests.json`, JSON.stringify(requests, null, 2))
  await adb('exec-out', 'screencap', '-p')
    .then(r => writeFile(`${output}/final.png`, r.stdout))
    .catch(() => {})
  await adb('logcat', '-d', '-t', '2000')
    .then(r => writeFile(`${output}/logcat.txt`, r.stdout))
    .catch(() => {})
  for (const port of ports) {
    await adb('reverse', '--remove', `tcp:${port}`).catch(() => {})
  }
  await adb('forward', '--remove', 'tcp:6000').catch(() => {})
  for (const server of servers) {
    server.closeAllConnections()
    server.close()
  }
}
