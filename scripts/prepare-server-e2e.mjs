import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const versions = JSON.parse(
  readFileSync(new URL('../tests/megaproxy-server/versions.json', import.meta.url))
)
const source = path.resolve('.cache/MegaProxyServer')
mkdirSync(path.dirname(source), { recursive: true })
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' })

try {
  if (!existsSync(path.join(source, '.git'))) {
    run('git', [
      'clone',
      '--no-checkout',
      'https://github.com/andre487/MegaProxyServer.git',
      source
    ])
  }

  run('git', ['-C', source, 'checkout', '--detach', versions.serverCommit])
  run('uv', ['sync', '--project', source, '--locked', '--no-dev'])
  for (const image of [versions.gost, versions.haproxy, versions.node]) {
    run('docker', ['pull', image])
  }
} catch (error) {
  console.error(
    'Server e2e setup failed. Install Docker (with a running daemon), uv and Git, then run npm run prepare:server-e2e.'
  )
  process.exitCode = error.status || 1
}
