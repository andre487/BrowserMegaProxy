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

for (const mode of ['anonymous', 'connect-udp']) {
  test(
    mode === 'anonymous'
      ? 'Firefox MASQUE routes HTTP/HTTPS through GOST'
      : 'GOST 3.3.0 exposes the CONNECT-UDP datagram size limitation',
    async ({ browserName }, testInfo) => {
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
              },
              ...(mode === 'connect-udp'
                ? [
                    {
                      name: 'origin-h3',
                      addr: `:${ports[1]}`,
                      handler: { type: 'http3' },
                      listener: { type: 'http3', tls },
                      forwarder: { nodes: [{ name: 'origin', addr: `127.0.0.1:${ports[0]}` }] }
                    }
                  ]
                : [])
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
            ...(mode === 'connect-udp'
              ? { 'network.http.http3.alt-svc-mapping-for-testing': `localhost;h3=:${ports[1]}` }
              : {}),
            // Playwright's certificate exceptions mark test certificates as third-party roots.
            'network.http.http3.disable_when_third_party_roots_found': false
          }
        })
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
          if (mode === 'connect-udp' && scheme === 'https') {
            // ponytail: pinned GOST 3.3.0 cannot encapsulate this origin's QUIC packets;
            // require successful HTTP/3 here when GOST gains oversized-datagram handling.
            await expect(navigation).rejects.toThrow(/NS_ERROR_PROXY_CONNECTION_REFUSED/)
            await expect.poll(() => logs).toContain('DATAGRAM frame too large')
          } else {
            await navigation
            await expect(page.locator('body')).toHaveText('MASQUE reached origin')
          }
        }
        expect(logs).toContain('connect-tcp request')
        if (mode === 'connect-udp') {
          expect(logs).toContain('connect-udp request')
          expect(logs).toContain('origin-h3')
        }
        const stopped = new Promise(resolve => proxy.once('exit', resolve))
        proxy.kill('SIGTERM')
        await stopped
        const count = headers.length
        await expect(
          page.goto(`https://localhost:${ports[1]}/?offline=1`, { timeout: 5000 })
        ).rejects.toThrow()
        expect(headers.length).toBe(count)
        expect(headers.length).toBeGreaterThanOrEqual(mode === 'anonymous' ? 2 : 1)
        expect(headers.every(header => !header['proxy-authorization'])).toBe(true)
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
    }
  )
}
