import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'

export async function readListing(directory) {
  const fields = await Promise.all(
    ['name', 'summary', 'description', 'homepage', 'support'].map(async field => {
      const value = (await readFile(path.join(directory, `${field}.txt`), 'utf8')).trim()
      assert.ok(value, `Missing store listing ${directory}/${field}`)
      return [field, value]
    })
  )
  const captions = (await readFile(path.join(directory, 'screenshot-captions.txt'), 'utf8'))
    .trim()
    .split(/\r?\n/u)
    .map(line => line.trim())
  assert.ok(captions.every(Boolean), `Missing screenshot caption in ${directory}`)
  return { ...Object.fromEntries(fields), screenshotCaptions: captions }
}

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
