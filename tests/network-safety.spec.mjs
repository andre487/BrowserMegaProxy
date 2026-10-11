import { execFileSync } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { expect, test } from '@playwright/test'
import { launchExtension } from './browser-extension.mjs'

const listen = (server, host = '127.0.0.1') =>
  new Promise(resolve => server.listen(0, host, () => resolve(server.address().port)))
const close = server =>
  new Promise(resolve => {
    server.closeAllConnections?.()
    server.close(resolve)
  })

// eslint-disable-next-line no-empty-pattern
test('unavailable proxies cannot silently reach an otherwise accessible origin directly', async ({}, testInfo) => {
  test.setTimeout(60000)
  let hits = 0
  const origin = http.createServer((_req, res) => {
    hits++
    res.end('reachable directly')
  })
  const port = await listen(origin, '::1')
  const sockets = new Set()
  const stalled = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  const stalledPort = await listen(stalled)
  const reserved = net.createServer()
  const refusedPort = await listen(reserved)
  await close(reserved)
  let browser
  try {
    browser = await launchExtension(testInfo.project.name, testInfo.outputPath('browser'))
    let page = await browser.context.newPage()
    const url = `http://[::1]:${port}/`
    await page.goto(url)
    await expect(page.locator('body')).toHaveText('reachable directly')
    await browser.command({ command: 'bypassLocalNetworks', enabled: false })
    for (const proxyPort of [refusedPort, stalledPort]) {
      await browser.command({
        command: 'save',
        profile: {
          id: 'broken',
          type: 'http',
          host: '127.0.0.1',
          port: proxyPort,
          bypass: ['127.0.0.1']
        }
      })
      await browser.command({ command: 'activate', id: 'broken' })
      const before = hits
      await expect(page.goto(`${url}?proxy=${proxyPort}`, { timeout: 5000 })).rejects.toThrow()
      expect(hits).toBe(before)
      await page.close()
      page = await browser.context.newPage()
    }
    await browser.command({ command: 'connectionMode', mode: 'direct' })
    await page.goto(`${url}?direct`)
    await expect(page.locator('body')).toHaveText('reachable directly')
  } finally {
    await browser?.close()
    for (const socket of sockets) {
      socket.destroy()
    }
    await Promise.all([close(stalled), close(origin)])
  }
})

// eslint-disable-next-line no-empty-pattern
test('strict TLS rejects an untrusted HTTPS proxy without a direct fallback', async ({}, testInfo) => {
  test.setTimeout(60000)
  const dir = testInfo.outputPath('certificates')
  await mkdir(dir, { recursive: true })
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
      '1'
    ],
    { stdio: 'ignore' }
  )
  let hits = 0
  const origin = http.createServer((_req, res) => {
    hits++
    res.end('reachable directly')
  })
  const port = await listen(origin, '::1')
  const proxy = https.createServer({
    key: await readFile(`${dir}/key.pem`),
    cert: await readFile(`${dir}/cert.pem`)
  })
  let connected = false
  proxy.on('connect', (_req, socket) => {
    connected = true
    socket.destroy()
  })
  const proxyPort = await listen(proxy)
  let browser
  try {
    browser = await launchExtension(testInfo.project.name, testInfo.outputPath('browser'), {
      ignoreHTTPSErrors: false
    })
    const page = await browser.context.newPage()
    const url = `http://[::1]:${port}/`
    await page.goto(url)
    await browser.command({
      command: 'save',
      profile: {
        id: 'untrusted',
        type: 'https',
        host: '127.0.0.1',
        port: proxyPort,
        bypass: ['127.0.0.1']
      }
    })
    await browser.command({ command: 'bypassLocalNetworks', enabled: false })
    await browser.command({ command: 'activate', id: 'untrusted' })
    const before = hits
    await expect(page.goto(`${url}?strict`, { timeout: 10000 })).rejects.toThrow()
    expect(connected).toBe(false)
    expect(hits).toBe(before)
    expect((await browser.networkErrors()).some(error => /CERT|PROXY/i.test(error.error))).toBe(
      true
    )
  } finally {
    await browser?.close()
    await Promise.all([close(proxy), close(origin)])
  }
})
