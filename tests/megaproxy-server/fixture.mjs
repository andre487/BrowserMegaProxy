import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const versions = JSON.parse(await readFile(new URL('./versions.json', import.meta.url)))
const source = path.resolve('.cache/MegaProxyServer')
const docker = async (...args) => {
  const result = await exec('docker', args, { timeout: 60000 })
  return (result.stdout + (args[0] === 'logs' ? result.stderr : '')).trim()
}

export async function networkDiagnostics(
  containers = [],
  command = exec,
  platform = process.platform
) {
  const commands = [
    ['ip', '-Version'],
    ['ip', 'address', 'show'],
    ['ip', '-6', 'address', 'show'],
    ['ip', 'route', 'show', 'table', 'all'],
    ['ip', '-6', 'route', 'show', 'table', 'all'],
    ['ip', 'rule', 'show'],
    ['ss', '-s'],
    ['ss', '-tanp']
  ]
  const capture = async args => {
    try {
      const result = await command(args[0], args.slice(1), { timeout: 5000 })
      return `$ ${args.join(' ')}\n${result.stdout}${result.stderr}`
    } catch (error) {
      return `$ ${args.join(' ')}\nUnavailable or failed: ${error.code || error.message}\n${error.stdout || ''}${error.stderr || ''}`
    }
  }
  const host = await Promise.all(commands.map(capture))
  const namespaces = await Promise.all(
    containers.map(async name => {
      const network = await capture([
        'docker',
        'inspect',
        '--format',
        '{{json .NetworkSettings.Networks}}',
        name
      ])
      if (platform !== 'linux') {
        return `${name}\n${network}\nContainer namespaces require a local Linux Docker host.`
      }
      try {
        const { stdout } = await command(
          'docker',
          ['inspect', '--format', '{{.State.Pid}}', name],
          { timeout: 5000 }
        )
        const pid = stdout.trim()
        if (!/^[1-9]\d*$/.test(pid)) {
          return `${name}\n${network}\nContainer is not running.`
        }
        const sockets = await Promise.all(
          commands.map(args => capture(['sudo', '-n', 'nsenter', '-t', pid, '-n', '--', ...args]))
        )
        return `${name}\n${network}\n${sockets.join('\n')}`
      } catch (error) {
        return `${name}\n${network}\nNamespace unavailable: ${error.code || error.message}`
      }
    })
  )
  return `Host network (iproute2)\n${host.join('\n')}\n${namespaces.join('\n')}`
}

async function freePort() {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

export async function startServer(scenario) {
  await mkdir('.cache/server-e2e', { recursive: true })
  const dir = await mkdtemp(path.resolve('.cache/server-e2e/run-'))
  const network = `megaproxy-e2e-${path.basename(dir)}`
  const containers = []
  const close = async () => {
    for (const name of containers.reverse()) {
      await docker('rm', '--force', name).catch(() => {})
    }
    await docker('network', 'rm', network).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
  const run = async (name, image, args = [], flags = []) => {
    const id = `${network}-${name}`
    containers.push(id)
    await docker(
      'run',
      '--detach',
      '--name',
      id,
      '--network',
      network,
      '--mount',
      `type=bind,src=${dir},dst=/fixture,readonly`,
      ...flags,
      image,
      ...args
    )
    return id
  }
  try {
    await exec('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      `${dir}/ca.key`,
      '-out',
      `${dir}/ca.pem`,
      '-subj',
      '/CN=MegaProxy e2e CA',
      '-days',
      '1'
    ])
    await exec('openssl', [
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      `${dir}/privkey.pem`,
      '-out',
      `${dir}/server.csr`,
      '-subj',
      '/CN=direct.localhost'
    ])
    await writeFile(
      `${dir}/extensions.cnf`,
      'subjectAltName=DNS:direct.localhost,DNS:chain.localhost,DNS:exit.internal,DNS:*.invalid,DNS:example.com,DNS:raw.githubusercontent.com,DNS:ifconfig.me,DNS:api.ipify.org,DNS:icanhazip.com,DNS:ifconfig.co,DNS:ipapi.co,DNS:api.country.is,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n'
    )
    await exec('openssl', [
      'x509',
      '-req',
      '-in',
      `${dir}/server.csr`,
      '-CA',
      `${dir}/ca.pem`,
      '-CAkey',
      `${dir}/ca.key`,
      '-CAcreateserial',
      '-out',
      `${dir}/fullchain.pem`,
      '-days',
      '1',
      '-extfile',
      `${dir}/extensions.cnf`
    ])
    await copyFile(new URL('./origin.mjs', import.meta.url), `${dir}/origin.mjs`)
    const proxyPort = await freePort()
    await exec(
      'uv',
      [
        'run',
        '--project',
        source,
        '--locked',
        '--no-dev',
        'python',
        path.resolve('tests/megaproxy-server/render.py'),
        source,
        dir,
        scenario,
        String(proxyPort)
      ],
      { timeout: 60000 }
    )
    await docker('network', 'create', network)
    const aliases = [
      'target.invalid',
      'wrong.invalid',
      'failure.invalid',
      'knock.invalid',
      'cdn.invalid',
      'subscription.invalid',
      'child.subscription.invalid',
      'raw.githubusercontent.com',
      'example.com',
      'ifconfig.me',
      'api.ipify.org',
      'icanhazip.com',
      'ifconfig.co',
      'ipapi.co',
      'api.country.is'
    ]
    const origin = await run(
      'origin',
      versions.node,
      ['/fixture/origin.mjs'],
      [
        '--publish',
        '127.0.0.1::80',
        '--publish',
        '127.0.0.1::443',
        ...aliases.flatMap(host => ['--network-alias', host])
      ]
    )
    const exit = await run(
      'exit',
      versions.gost,
      ['-C', '/fixture/exit.json'],
      ['--network-alias', 'exit.internal', '--env', 'SSL_CERT_FILE=/fixture/ca.pem']
    )
    const entry = await run(
      'entry',
      versions.gost,
      ['-C', '/fixture/entry.json'],
      ['--publish', `127.0.0.1:${proxyPort}:18443`, '--env', 'SSL_CERT_FILE=/fixture/ca.pem']
    )
    const frontend = `${network}-frontend`
    containers.push(frontend)
    await docker(
      'run',
      '--detach',
      '--user',
      '0',
      '--name',
      frontend,
      '--network',
      `container:${entry}`,
      '--mount',
      `type=bind,src=${dir},dst=/fixture,readonly`,
      versions.haproxy,
      'haproxy',
      '-db',
      '-f',
      '/fixture/haproxy.cfg'
    )
    const port = async internal =>
      Number((await docker('port', origin, `${internal}/tcp`)).split(':').at(-1))
    const originHttpPort = await port(80)
    const originTlsPort = await port(443)
    const address = async container =>
      await docker(
        'inspect',
        '--format',
        '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
        container
      )
    const requests = async () =>
      (await fetch(`http://127.0.0.1:${originHttpPort}/__requests`)).json()
    for (let attempt = 0; ; attempt++) {
      try {
        await requests()
        await probe(
          proxyPort,
          scenario === 'chain-only'
            ? 'chain.localhost'
            : scenario === 'ip'
              ? ''
              : 'direct.localhost',
          'knock.invalid:443'
        )
        break
      } catch (error) {
        if (attempt >= 49) {
          throw error
        }
        await delay(100)
      }
    }
    return {
      dir,
      proxyPort,
      ca: await readFile(`${dir}/ca.pem`),
      selfSignedExport: await readFile(`${dir}/self-signed-exports/MegaProxy.json`, 'utf8'),
      originTlsPort,
      requests,
      entryAddress: await address(entry),
      exitAddress: await address(exit),
      exports: Object.fromEntries(
        await Promise.all(
          ['MegaProxy.json', 'FoxyProxy.json', 'ProxyList.txt', 'SuperProxy.txt'].map(
            async name => [name, await readFile(`${dir}/exports/${name}`, 'utf8')]
          )
        )
      ),
      stopExit: () => docker('stop', '--time', '0', exit),
      diagnostics: () => networkDiagnostics(containers),
      logs: async () =>
        (
          await Promise.all(containers.map(async name => `${name}\n${await docker('logs', name)}`))
        ).join('\n'),
      close
    }
  } catch (error) {
    const logs = await Promise.all(containers.map(name => docker('logs', name).catch(() => '')))
    const diagnostics = await networkDiagnostics(containers)
    await close()
    throw new Error(`${error.message}\n${logs.join('\n')}\n${diagnostics}`, { cause: error })
  }
}

// Observe the real wire response without browser credential caching or native dialogs.
export function probe(port, servername, target, credential, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host: '127.0.0.1',
        port,
        servername,
        rejectUnauthorized: false,
        ALPNProtocols: ['http/1.1'],
        ...options
      },
      () => {
        socket.write(
          `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${credential ? `Proxy-Authorization: Basic ${Buffer.from(credential).toString('base64')}\r\n` : ''}Connection: close\r\n\r\n`
        )
      }
    )
    let response = ''
    socket.setTimeout(3000, () => socket.destroy(new Error('Proxy probe timed out')))
    socket.on('error', reject)
    socket.on('data', chunk => {
      response += chunk
      if (response.includes('\r\n\r\n')) {
        socket.destroy()
        resolve(response)
      }
    })
    socket.on('close', () => {
      if (!response.includes('\r\n\r\n')) {
        reject(new Error('Proxy closed without an HTTP response'))
      }
    })
  })
}
