import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import sharp from 'sharp'

test('identity snapshot is pinned and PNG icons match its unchanged SVGs', async () => {
  const directory = 'extension/icons'
  const lock = JSON.parse(await readFile(`${directory}/identity-lock.json`, 'utf8'))
  assert.equal(lock.repository, 'https://github.com/andre487/MegaProxyIdentity')
  assert.match(lock.commit, /^[a-f0-9]{40}$/)
  assert.deepEqual(Object.keys(lock.files).sort(), [
    'LICENSE',
    'SVG/chrome-promo-big.svg',
    'SVG/chrome-promo-little.svg',
    'SVG/feature-graphic.svg',
    'SVG/icon-radius.svg',
    'SVG/icon-toolbar.svg',
    'SVG/shop-icon.svg',
    'SVG/social-preview.svg'
  ])
  for (const [file, hash] of Object.entries(lock.files)) {
    const source = await readFile(`${directory}/${file.split('/').at(-1)}`)
    assert.equal(createHash('sha256').update(source).digest('hex'), hash, file)
  }
  for (const [source, sizes, prefix] of [
    ['icon-toolbar.svg', [16, 24, 32, 48, 64], 'toolbar'],
    ['icon-radius.svg', [48, 128, 512], 'icon']
  ]) {
    for (const size of sizes) {
      const expected = await sharp(`${directory}/${source}`, { density: 192 })
        .resize(size, size)
        .ensureAlpha()
        .raw()
        .toBuffer()
      const actual = await sharp(`${directory}/${prefix}${size === 512 ? '' : size}.png`)
        .ensureAlpha()
        .raw()
        .toBuffer()
      assert.deepEqual(actual, expected, `${prefix}${size}`)
    }
  }
  for (const size of [16, 32]) {
    assert.deepEqual(
      await readFile(`${directory}/icon${size}.png`),
      await readFile(`${directory}/toolbar${size}.png`)
    )
  }
  for (const [source, width, height, destination] of [
    ['shop-icon.svg', 128, 128, 'store/assets/shared/icon-128.png'],
    ['chrome-promo-little.svg', 440, 280, 'store/assets/shared/promo-small.png'],
    ['chrome-promo-big.svg', 1400, 560, 'store/assets/shared/promo-marquee.png'],
    ['social-preview.svg', 1280, 640, 'docs/assets/social-preview.png']
  ]) {
    const metadata = await sharp(destination).metadata()
    assert.equal(metadata.format, 'png')
    assert.equal(metadata.width, width)
    assert.equal(metadata.height, height)
    assert.deepEqual(
      await sharp(destination).ensureAlpha().raw().toBuffer(),
      await sharp(`${directory}/${source}`, { density: 192 })
        .resize(width, height)
        .ensureAlpha()
        .raw()
        .toBuffer(),
      destination
    )
  }
  assert.deepEqual(
    await readFile('store/assets/shared/LICENSE'),
    await readFile(`${directory}/LICENSE`)
  )
})
