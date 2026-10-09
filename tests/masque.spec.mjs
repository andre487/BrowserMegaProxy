import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import dgram from 'node:dgram'
import https from 'node:https'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { launchExtension } from './browser-extension.mjs'

const listen = server =>
  new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

test('Firefox MASQUE routes HTTP/HTTPS through GOST', async ({ browserName }, testInfo) => {
  test.setTimeout(45000)
  test.skip(browserName !== 'firefox', 'MASQUE requires Firefox 146+')
  const dir = await mkdtemp(path.join(tmpdir(), 'mega-masque-'))
  const headers = []
  const handler = (req, res) => {
    headers.push(req.headers)
    res.end('MASQUE reached origin')
  }
  const origin = http.createServer(handler)
  let secureOrigin, proxy, browser
  let logs = ''
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
        '/CN=localhost',
        '-days',
        '1',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1'
      ],
      { stdio: 'ignore' }
    )
    secureOrigin = https.createServer(
      { key: await readFile(`${dir}/key.pem`), cert: await readFile(`${dir}/cert.pem`) },
      handler
    )
    const ports = [await listen(origin), await listen(secureOrigin)]
    const reservation = dgram.createSocket('udp4')
    await new Promise(resolve => reservation.bind(0, '127.0.0.1', resolve))
    const proxyPort = reservation.address().port
    await new Promise(resolve => reservation.close(resolve))
    const tls = { certFile: `${dir}/cert.pem`, keyFile: `${dir}/key.pem` }
    await writeFile(
      `${dir}/gost.json`,
      JSON.stringify({
        log: { level: 'debug' },
        services: [
          {
            name: 'masque',
            addr: `127.0.0.1:${proxyPort}`,
            handler: { type: 'masque' },
            listener: {
              type: 'http3',
              metadata: { enableDatagrams: true },
              tls
            }
          }
        ]
      })
    )
    proxy = spawn(
      process.env.GOST_BIN || path.resolve('.cache/gost/gost'),
      ['-C', `${dir}/gost.json`],
      { cwd: dir }
    )
    proxy.stdout.on('data', data => {
      logs += data
    })
    proxy.stderr.on('data', data => {
      logs += data
    })
    proxy.on('error', error => {
      logs += error.message
    })
    await expect.poll(() => logs).toContain('listening on')
    browser = await launchExtension('firefox', dir, {
      firefoxUserPrefs: {
        'network.http.http3.enable': true,
        // Playwright's certificate exceptions mark test certificates as third-party roots.
        'network.http.http3.disable_when_third_party_roots_found': false
      }
    })
    const profile = { type: 'masque', name: 'MASQUE', host: '127.0.0.1', port: proxyPort }
    await expect(browser.command({ command: 'save', profile })).rejects.toThrow(
      'errorMasqueDisabled'
    )
    const preview = await browser.command({
      command: 'previewImport',
      data: `masque://127.0.0.1:${proxyPort}`
    })
    expect(preview.skippedMasque).toBe(true)
    expect(preview.added).toBe(0)
    expect((await browser.command({ command: 'masqueEnabled', enabled: true })).ok).toBe(true)
    const saved = await browser.command({
      command: 'save',
      profile: {
        type: 'masque',
        name: 'MASQUE',
        host: '127.0.0.1',
        port: proxyPort
      }
    })
    expect(saved.ok).toBe(true)
    expect(
      (
        await browser.command({
          command: 'routing',
          routing: { enabled: true, mode: 'domains', domains: ['localhost'] }
        })
      ).ok
    ).toBe(true)
    expect((await browser.command({ command: 'bypassLocalNetworks', enabled: false })).ok).toBe(
      true
    )
    expect(
      (await browser.command({ command: 'activate', id: saved.state.profiles[0].id })).ok
    ).toBe(true)
    const page = await browser.context.newPage()
    for (const [index, scheme] of ['http', 'https'].entries()) {
      const navigation = page.goto(`${scheme}://localhost:${ports[index]}/`, { timeout: 12000 })
      await navigation
      await expect(page.locator('body')).toHaveText('MASQUE reached origin')
    }
    expect(logs).toContain('connect-tcp request')
    const stopped = new Promise(resolve => proxy.once('exit', resolve))
    proxy.kill('SIGTERM')
    await stopped
    const count = headers.length
    await expect(
      page.goto(`https://localhost:${ports[1]}/?offline=1`, { timeout: 5000 })
    ).rejects.toThrow()
    expect(headers.length).toBe(count)
    expect(headers.length).toBeGreaterThanOrEqual(2)
    expect(headers.every(header => !header['proxy-authorization'])).toBe(true)
    const disabled = await browser.command({ command: 'masqueEnabled', enabled: false })
    expect(disabled.ok).toBe(true)
    expect(disabled.state.profiles).toHaveLength(1)
    expect(disabled.state.activeId).toBe(null)
    await expect(
      browser.command({ command: 'activate', id: saved.state.profiles[0].id })
    ).rejects.toThrow('errorMasqueDisabled')
  } finally {
    await mkdir(path.dirname(testInfo.outputPath('gost.log')), { recursive: true })
    await writeFile(testInfo.outputPath('gost.log'), logs)
    await testInfo.attach('gost.log', {
      path: testInfo.outputPath('gost.log'),
      contentType: 'text/plain'
    })
    await browser?.close()
    if (proxy && proxy.exitCode === null) {
      const stopped = new Promise(resolve => proxy.once('exit', resolve))
      proxy.kill('SIGTERM')
      await stopped
    }
    origin.closeAllConnections()
    await new Promise(resolve => origin.close(resolve))
    if (secureOrigin) {
      secureOrigin.closeAllConnections()
      await new Promise(resolve => secureOrigin.close(resolve))
    }
    await rm(dir, { recursive: true, force: true })
  }
})
