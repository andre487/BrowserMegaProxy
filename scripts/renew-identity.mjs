import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { requestWithRetry } from './http-request.mjs'

const repository = 'andre487/MegaProxyIdentity'
const args = process.argv.slice(2)
if (args.length > 1 || args.some(arg => !/^--ref=[A-Za-z0-9._/-]+$/.test(arg))) {
  throw new Error('Use npm run renew-identity -- [--ref=<commit-or-branch>]')
}
async function download(path) {
  const response = await requestWithRetry(fetch, path, { signal: AbortSignal.timeout(30000) })
  if (!response.ok) {
    throw new Error(`Identity download failed: HTTP ${response.status} ${path}`)
  }
  return response.text()
}
const ref = args[0]?.slice(6) || 'main'
const commit = /^[a-f0-9]{40}$/.test(ref)
  ? ref
  : JSON.parse(
      await download(
        `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(ref)}`
      )
    ).sha
if (!/^[a-f0-9]{40}$/.test(commit)) {
  throw new Error('GitHub returned an invalid commit')
}
const files = ['SVG/icon-radius.svg', 'SVG/icon-toolbar.svg', 'SVG/feature-graphic.svg', 'LICENSE']
const contents = await Promise.all(
  files.map(file => download(`https://raw.githubusercontent.com/${repository}/${commit}/${file}`))
)
// Validate every SVG before replacing the local snapshot.
const { default: sharp } = await import('sharp')
for (const svg of contents.slice(0, -1)) {
  const metadata = await sharp(Buffer.from(svg)).metadata()
  if (metadata.format !== 'svg') {
    throw new Error('Expected an SVG identity source')
  }
}
await mkdir('extension/icons', { recursive: true })
for (const [index, file] of files.entries()) {
  await writeFile(`extension/icons/${file.split('/').at(-1)}`, contents[index])
}
await writeFile(
  'extension/icons/identity-lock.json',
  JSON.stringify(
    {
      repository: `https://github.com/${repository}`,
      commit,
      files: Object.fromEntries(
        files.map((file, index) => [
          file,
          createHash('sha256').update(contents[index]).digest('hex')
        ])
      )
    },
    null,
    2
  ) + '\n'
)
await import('./renew-toolbar-icons.mjs')
console.log(`Updated MegaProxy identity to ${commit}. Review and commit generated assets.`)
