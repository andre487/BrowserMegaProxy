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
await mkdir('docs/assets', { recursive: true })
for (const [source, width, height, destination] of [
  ['shop-icon.svg', 128, 128, 'store/assets/shared/icon-128.png'],
  ['chrome-promo-little.svg', 440, 280, 'store/assets/shared/promo-small.png'],
  ['chrome-promo-big.svg', 1400, 560, 'store/assets/shared/promo-marquee.png'],
  ['social-preview.svg', 1280, 640, 'docs/assets/social-preview.png']
]) {
  const image = sharp(`${directory}/${source}`, { density: 192 }).resize(width, height)
  if (source.startsWith('chrome-promo-')) {
    image.flatten({ background: '#10283f' })
  }
  await image.png().toFile(destination)
}
