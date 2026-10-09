import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { launchExtension } from './browser-extension.mjs'

const listen = server =>
  new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

// A real SOCKS5 handshake proves remote DNS and authentication without an external service.
async function socksServer(originPorts, authenticated) {
  const requests = []
  const sockets = new Set()
  const track = socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    return socket
  }
  const server = net.createServer(socket => {
    track(socket)
    let pending = Buffer.alloc(0)
    let phase = 'greeting'
    const onData = data => {
      pending = Buffer.concat([pending, data])
      while (true) {
        if (phase === 'greeting') {
          if (pending.length < 2 || pending.length < 2 + pending[1]) {
            return
          }
          const method = authenticated ? 2 : 0
          if (pending[0] !== 5 || !pending.subarray(2, 2 + pending[1]).includes(method)) {
            socket.end(Buffer.from([5, 255]))
            return
          }
          pending = pending.subarray(2 + pending[1])
          socket.write(Buffer.from([5, method]))
          phase = authenticated ? 'authentication' : 'request'
        } else if (phase === 'authentication') {
          if (pending.length < 2 || pending.length < 3 + pending[1]) {
            return
          }
          const length = 3 + pending[1] + pending[2 + pending[1]]
          if (pending.length < length) {
            return
          }
          const username = pending.subarray(2, 2 + pending[1]).toString()
          const password = pending.subarray(3 + pending[1], length).toString()
          const accepted = pending[0] === 1 && username === 'user' && password === 'secret'
          requests.push({ username, password, accepted })
          pending = pending.subarray(length)
          if (!accepted) {
            socket.end(Buffer.from([1, 1]))
            return
          }
          socket.write(Buffer.from([1, 0]))
          phase = 'request'
        } else {
          if (pending.length < 5) {
            return
          }
          const size = pending[3] === 3 ? pending[4] + 1 : pending[3] === 1 ? 4 : 16
          const length = 6 + size
          if (pending.length < length) {
            return
          }
          const host = pending[3] === 3 ? pending.subarray(5, 4 + size).toString() : ''
          const port = pending.readUInt16BE(4 + size)
          requests.push({ host, port })
          socket.off('data', onData)
          if (
            pending[0] !== 5 ||
            pending[1] !== 1 ||
            host !== 'socks-target.invalid' ||
            !originPorts.includes(port)
          ) {
            socket.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]))
            return
          }
          const upstream = track(
            net.connect(port, '127.0.0.1', () => {
              socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
              const rest = pending.subarray(length)
              if (rest.length) {
                upstream.write(rest)
              }
              socket.pipe(upstream).pipe(socket)
            })
          )
          socket.on('close', () => upstream.destroy())
          upstream.on('close', () => socket.destroy())
          return
        }
      }
    }
    socket.on('data', onData)
  })
  const port = await listen(server)
  return {
    port,
    requests,
    close: () => {
      for (const socket of sockets) {
        socket.destroy()
      }
      return new Promise(resolve => server.close(resolve))
    }
  }
}

for (const authenticated of [false, true]) {
  // eslint-disable-next-line no-empty-pattern
  test(`installed SOCKS5 routes with remote DNS (${authenticated ? 'credentials' : 'anonymous'})`, async ({}, testInfo) => {
    test.skip(
      authenticated && testInfo.project.name === 'chromium',
      'Chromium has no SOCKS5 authentication'
    )
    const dir = await mkdtemp(path.join(tmpdir(), 'mega-socks5-'))
    const headers = []
    const handler = (request, response) => {
      headers.push(request.headers)
      response.end('SOCKS5 reached origin')
    }
    const origin = http.createServer(handler)
    let secureOrigin, proxy, browser
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
          '/CN=socks-target.invalid',
          '-days',
          '1'
        ],
        { stdio: 'ignore' }
      )
      secureOrigin = https.createServer(
        { key: await readFile(`${dir}/key.pem`), cert: await readFile(`${dir}/cert.pem`) },
        handler
      )
      proxy = await socksServer([await listen(origin), await listen(secureOrigin)], authenticated)
      browser = await launchExtension(testInfo.project.name, dir)
      const credentials = authenticated ? { username: 'user', password: 'secret' } : {}
      const saved = await browser.command({
        command: 'save',
        profile: {
          type: 'socks5',
          name: 'SOCKS5',
          host: '127.0.0.1',
          port: proxy.port,
          ...credentials
        }
      })
      expect(saved.ok).toBe(true)
      const id = saved.state.profiles[0].id
      expect((await browser.command({ command: 'activate', id })).ok).toBe(true)
      const page = await browser.context.newPage()
      for (const enabled of [false, true]) {
        expect(
          (
            await browser.command({
              command: 'routing',
              routing: {
                enabled,
                mode: 'domains',
                domains: ['socks-target.invalid']
              }
            })
          ).ok
        ).toBe(true)
        for (const [protocol, server] of [
          ['http', origin],
          ['https', secureOrigin]
        ]) {
          await page.goto(
            `${protocol}://socks-target.invalid:${server.address().port}/?routing=${enabled}`
          )
          await expect(page.locator('body')).toHaveText('SOCKS5 reached origin')
        }
      }
      expect(
        proxy.requests.filter(request => request.host === 'socks-target.invalid').length
      ).toBeGreaterThanOrEqual(1)
      expect(headers.length).toBeGreaterThanOrEqual(4)
      expect(headers.every(header => !header['proxy-authorization'])).toBe(true)
      if (authenticated) {
        expect(
          proxy.requests.some(
            request =>
              request.username === 'user' && request.password === 'secret' && request.accepted
          )
        ).toBe(true)
        origin.closeAllConnections()
        expect(
          (await browser.command({ command: 'save', profile: { id, password: 'wrong' } })).ok
        ).toBe(true)
        await expect(
          page.goto(`http://socks-target.invalid:${origin.address().port}/?wrong=1`)
        ).rejects.toThrow()
        expect(
          proxy.requests.some(request => request.password === 'wrong' && !request.accepted)
        ).toBe(true)
      }
    } finally {
      await browser?.close()
      await proxy?.close()
      if (secureOrigin) {
        secureOrigin.closeAllConnections()
        await new Promise(resolve => secureOrigin.close(resolve))
      }
      origin.closeAllConnections()
      await new Promise(resolve => origin.close(resolve))
      await rm(dir, { recursive: true, force: true })
    }
  })
}
