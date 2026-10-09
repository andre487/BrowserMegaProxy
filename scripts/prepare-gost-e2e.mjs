import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { requestWithRetry } from './http-request.mjs'

const version = '3.3.0'
const checksums = {
  darwin_amd64: '9be5b30354bbe59b6b160af01c66b209c93335db29b272b67bd73feca4abe4ec',
  darwin_arm64: 'f170226106844b50ab3435147f35d4300da773efca256b50cb2f8c7d3a151101',
  linux_amd64: '676fb7f78d267b6ae73df719c0c7f2b565dde7147da935cfafbc1e1da558b6d5',
  linux_arm64: 'd03699e3f385d4ff5dad68046712adfcc7515325a064d2ab046e0bece30f8f8f'
}
const platform = `${process.platform}_${process.arch === 'x64' ? 'amd64' : process.arch}`
const checksum = checksums[platform]
if (!checksum) {
  throw new Error(`GOST MASQUE test binary is unavailable for ${platform}`)
}
const dir = path.resolve('.cache/gost')
const archive = `${dir}/gost_${version}_${platform}.tar.gz`
await mkdir(dir, { recursive: true })
let bytes = await readFile(archive).catch(() => null)
if (!bytes || createHash('sha256').update(bytes).digest('hex') !== checksum) {
  const response = await requestWithRetry(
    fetch,
    `https://github.com/go-gost/gost/releases/download/v${version}/${path.basename(archive)}`,
    { signal: AbortSignal.timeout(60000) }
  )
  if (!response.ok) {
    throw await globalThis.MegaErrors.httpError(
      response,
      `GOST download failed: HTTP ${response.status}`
    )
  }
  bytes = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== checksum) {
    throw new Error('GOST archive checksum mismatch')
  }
  await writeFile(archive, bytes)
}
await rm(`${dir}/gost`, { force: true })
execFileSync('tar', ['-xzf', archive, '-C', dir, 'gost'])
console.log(`Prepared GOST ${version} for MASQUE tests`)
