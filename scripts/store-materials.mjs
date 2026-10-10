import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFile } from 'node:fs/promises'

export function readStoreFile(tag, file) {
  assert.match(tag, /^v\d+\.\d+\.\d+$/)
  assert.ok(file.startsWith('store/') && !file.split('/').includes('..'))
  return execFileSync('unzip', ['-p', `dist/release/MegaProxy-store-materials-${tag}.zip`, file], {
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

export async function reportStoreDashboard(name, url, env = process.env) {
  console.log(`${name} developer dashboard: ${url}`)
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, `[${name} developer dashboard](${url})\n\n`)
  }
}
