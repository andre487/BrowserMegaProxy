import { requestWithRetry } from './http-request.mjs'
import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import Ajv from 'ajv/dist/2020.js'

const repository = 'andre487/MegaProxyConfig'
const args = process.argv.slice(2)
if (args.length > 1 || args.some(arg => !/^--ref=[A-Za-z0-9._/-]+$/.test(arg))) {
  throw new Error('Use npm run renew-config-schema -- [--ref=<commit-or-branch>]')
}

const ref = args[0]?.slice(6) || 'main'
const directory = fileURLToPath(new URL('../config-schema/', import.meta.url))

async function download(url) {
  const response = await requestWithRetry(fetch, url, {
    signal: AbortSignal.timeout(30000),
    headers: { 'User-Agent': 'MegaProxy-schema-sync', 'Cache-Control': 'no-cache' }
  })
  if (!response.ok) {
    throw await globalThis.MegaErrors.httpError(
      response,
      `Schema download failed: HTTP ${response.status} ${url}`
    )
  }

  return response.text()
}

const commit = /^[a-f0-9]{40}$/.test(ref)
  ? ref
  : JSON.parse(
      await download(
        `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(ref)}?renew=${Date.now()}`
      )
    ).sha
if (!/^[a-f0-9]{40}$/.test(commit)) {
  throw new Error('GitHub returned an invalid commit')
}

const files = ['schemas/megaproxy-v8.schema.json', 'schemas/android-v8.schema.json', 'LICENSE']
const upstream = await Promise.all(
  files.map(file => download(`https://raw.githubusercontent.com/${repository}/${commit}/${file}`))
)
const contents = upstream
const ajv = new Ajv({ strict: true })
for (const text of contents.slice(0, 2)) {
  const schema = JSON.parse(text)
  if (schema.properties?.version?.const !== 8) {
    throw new Error('Unexpected schema version; update consumers explicitly')
  }

  ajv.compile(schema)
}

const lock = {
  repository: `https://github.com/${repository}`,
  commit,
  overrides: [],
  upstreamFiles: Object.fromEntries(
    files.map((file, index) => [
      file.split('/').at(-1),
      createHash('sha256').update(upstream[index]).digest('hex')
    ])
  ),
  files: Object.fromEntries(
    files.map((file, index) => [
      file.split('/').at(-1),
      createHash('sha256').update(contents[index]).digest('hex')
    ])
  )
}
await mkdir(directory, { recursive: true })
for (const [index, file] of files.entries()) {
  const destination = `${directory}/${file.split('/').at(-1)}`
  await writeFile(`${destination}.tmp`, contents[index])
  await rename(`${destination}.tmp`, destination)
}

await writeFile(`${directory}/schema-lock.json`, JSON.stringify(lock, null, 2) + '\n')
console.log(`Updated MegaProxy config schemas to ${commit}. Review and commit config-schema/.`)
