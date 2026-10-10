import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { readListing } from '../scripts/store-materials.mjs'

test('store listings and PNGs match supported browsers, locales and upload sizes', async () => {
  for (const store of ['chrome', 'firefox', 'opera']) {
    for (const locale of ['en', 'ru']) {
      const listing = await readListing(`store/listings/${store}/${locale}`)
      assert.equal(listing.name, 'MegaProxy')
      assert.ok(listing.summary.length <= 132)
      assert.ok(listing.description.length <= 16000)
      assert.equal(listing.screenshotCaptions.length, 5)
      assert.ok(listing.description.includes('407') || store === 'firefox')
      for (let n = 1; n <= 5; n++) {
        const target = store === 'firefox' ? 'firefox' : 'chromium'
        const png = await readFile(`store/assets/${target}/${locale}/0${n}.png`)
        assert.equal(png.readUInt32BE(16), 1280)
        assert.equal(png.readUInt32BE(20), 800)
        assert.equal(png[25], 2, 'Screenshots must be opaque RGB PNGs')
      }
    }
  }
  for (const locale of ['en', 'ru']) {
    for (let index = 1; index <= 3; index++) {
      const png = await readFile(`store/assets/opera/${locale}/0${index}.png`)
      assert.equal(png.readUInt32BE(16), 612)
      assert.equal(png.readUInt32BE(20), 408)
      assert.equal(png[25], 2)
    }
  }
  for (const [file, width, height, type] of [
    ['icon-64', 64, 64, 6],
    ['icon-128', 128, 128, 6],
    ['promo-opera', 300, 188, 2],
    ['promo-small', 440, 280, 2],
    ['promo-marquee', 1400, 560, 2]
  ]) {
    const png = await readFile(`store/assets/shared/${file}.png`)
    assert.equal(png.readUInt32BE(16), width)
    assert.equal(png.readUInt32BE(20), height)
    assert.equal(png[25], type)
  }
})

test('manual store actions include instructions and a dashboard link in annotations and job summaries', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { reportStoreAction } = await import('../scripts/store-materials.mjs')
  const directory = await mkdtemp(path.join(tmpdir(), 'mega-store-action-'))
  const summary = path.join(directory, 'summary.md')
  const warnings = []
  try {
    await reportStoreAction(
      'Example Store',
      'https://example.org/dashboard',
      'Fix metadata.\nSave 100% of changes.',
      {
        env: { GITHUB_STEP_SUMMARY: summary },
        warn: message => warnings.push(message)
      }
    )
    assert.match(warnings[0], /Manual action required/)
    assert.match(warnings[0], /Fix metadata\.%0ASave 100%25/)
    assert.match(warnings[0], /https:\/\/example\.org\/dashboard/)
    const markdown = await readFile(summary, 'utf8')
    assert.match(markdown, /manual action required/)
    assert.match(markdown, /Fix metadata/)
    assert.match(markdown, /\[Open developer dashboard\]\(https:\/\/example.org\/dashboard\)/)
    await reportStoreAction('Example Store', 'https://example.org/dashboard', 'Fix metadata.', {
      env: { GITHUB_STEP_SUMMARY: directory },
      warn: message => warnings.push(message)
    })
    assert.match(warnings.at(-1), /Could not write the job summary/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
