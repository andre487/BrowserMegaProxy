import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import sharp from 'sharp'

// Offline rendering: upstream SVGs are immutable; renew-identity updates the snapshot.
const directory = 'extension/icons'
const lock = JSON.parse(await readFile(`${directory}/identity-lock.json`, 'utf8'))
for (const [file, hash] of Object.entries(lock.files)) {
  assert.equal(
    createHash('sha256')
      .update(await readFile(`${directory}/${file.split('/').at(-1)}`))
      .digest('hex'),
    hash,
    `Modified identity source: ${file}. Run npm run renew-identity instead of editing locally.`
  )
}
for (const [source, sizes, prefix] of [
  ['icon-toolbar.svg', [16, 24, 32, 48, 64], 'toolbar'],
  ['icon-radius.svg', [48, 128, 512], 'icon']
]) {
  for (const size of sizes) {
    await sharp(`${directory}/${source}`, { density: 192 })
      .resize(size, size)
      .png()
      .toFile(`${directory}/${prefix}${size === 512 ? '' : size}.png`)
  }
}
for (const size of [16, 32]) {
  await copyFile(`${directory}/toolbar${size}.png`, `${directory}/icon${size}.png`)
}
await mkdir('store/assets/shared', { recursive: true })
await copyFile(`${directory}/LICENSE`, 'store/assets/shared/LICENSE')
await sharp(`${directory}/icon-radius.svg`, { density: 192 })
  .resize(96, 96)
  .extend({ top: 16, bottom: 16, left: 16, right: 16, background: '#0000' })
  .png()
  .toFile('store/assets/shared/icon-128.png')
for (const [width, height, name] of [
  [440, 280, 'promo-small'],
  [1400, 560, 'promo-marquee']
]) {
  await sharp(`${directory}/feature-graphic.svg`, { density: 192 })
    .resize(width, height, { fit: 'contain', background: '#10283f' })
    .flatten({ background: '#10283f' })
    .png()
    .toFile(`store/assets/shared/${name}.png`)
}
