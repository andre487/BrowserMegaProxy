import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { checkFirefoxStoreMaterials } from '../scripts/firefox-store-materials.mjs'

const listings = Object.fromEntries(
  ['en', 'ru'].map(language => [
    language,
    {
      name: 'MegaProxy',
      summary: `Summary ${language}`,
      description: 'Description & details',
      homepage: 'https://example.org',
      support: 'https://example.org/support',
      screenshotCaptions: [`Caption ${language}`]
    }
  ])
)
const published = () => ({
  guid: 'browser-mega-proxy@andre487',
  ...Object.fromEntries(
    ['name', 'summary', 'description'].map(field => [
      field,
      Object.fromEntries(
        [
          ['en-US', 'en'],
          ['ru', 'ru']
        ].map(([locale, language]) => [
          locale,
          field === 'description' ? '<p>Description &amp; details</p>' : listings[language][field]
        ])
      )
    ])
  ),
  homepage: { url: { 'en-US': listings.en.homepage, ru: listings.ru.homepage } },
  support_url: { url: { 'en-US': listings.en.support, ru: listings.ru.support } },
  icon_url: 'https://addons.mozilla.org/user-media/icon.png',
  previews: [1, 0].map(position => ({
    position,
    image_url: `https://addons.mozilla.org/user-media/${position}.png`,
    caption: { 'en-US': 'Caption en', ru: 'Caption ru' }
  }))
})

test('Firefox public checks compare localized texts, links, icon and shared gallery without authentication or writes', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'firefox-materials-'))
  const original = await sharp({
    create: { width: 64, height: 64, channels: 3, background: '#ff0000' }
  })
    .png()
    .toBuffer()
  const changed = await sharp(original).negate().png().toBuffer()
  try {
    for (const mismatch of [false, true]) {
      const addon = published()
      if (mismatch) {
        addon.summary.ru = 'Old summary'
        addon.support_url.url['en-US'] = 'https://old.example.org'
        addon.previews[0].caption.ru = 'Old caption'
        addon.previews.push({ ...addon.previews[0], position: 2 })
      }
      const calls = []
      const report = await checkFirefoxStoreMaterials({
        output,
        env: { GITHUB_STEP_SUMMARY: path.join(output, 'summary.md') },
        listing: async language => listings[language],
        load: async () => original,
        request: async (url, options) => {
          calls.push(url)
          assert.equal(options.method, undefined)
          assert.equal(options.headers, undefined)
          assert.equal(options.redirect, 'error')
          assert.ok(options.signal instanceof AbortSignal)
          return new Response(
            url.includes('/api/')
              ? JSON.stringify(addon)
              : mismatch && url.endsWith('/1.png')
                ? changed
                : original
          )
        }
      })
      assert.equal(calls.length, 4)
      assert.ok(report.includes('en: description matches'))
      if (mismatch) {
        for (const pattern of [
          /ru: published summary differs/,
          /en: published support differs/,
          /Shared screenshot count differs/,
          /ru-01: ru caption differs/,
          /ru-01: published image differs/
        ]) {
          assert.ok(
            report.some(line => pattern.test(line)),
            pattern.toString()
          )
        }
        assert.ok((await readFile(path.join(output, 'ru-01-difference.png'))).length)
        assert.match(
          await readFile(path.join(output, 'summary.md'), 'utf8'),
          /manual action required/
        )
      } else {
        assert.ok(!report.some(line => line.startsWith('Warning:')))
        assert.ok(report.includes('en-01: matches'))
        assert.ok(report.includes('ru-01: matches'))
      }
    }
  } finally {
    await rm(output, { recursive: true, force: true })
  }
})

test('Firefox public failures and untrusted image URLs warn without stopping publication or fetching other hosts', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'firefox-materials-'))
  try {
    for (const request of [
      async () => {
        throw new Error('Network down')
      },
      async () => new Response('Unavailable', { status: 429 }),
      async () => new Response('New layout'),
      async url => {
        assert.ok(url.includes('/api/'), 'Do not fetch untrusted images')
        const addon = published()
        addon.icon_url = 'https://untrusted.example/icon.png'
        addon.previews.forEach(preview => {
          preview.image_url = 'http://localhost/private'
        })
        return Response.json(addon)
      }
    ]) {
      const report = await checkFirefoxStoreMaterials({
        output,
        env: {},
        request,
        listing: async language => listings[language],
        load: async () => Buffer.from('invalid')
      })
      assert.ok(report.some(line => line.startsWith('Warning:')))
    }
    const report = await checkFirefoxStoreMaterials({
      output,
      env: {},
      request: async () => Response.json(published()),
      listing: async () => {
        throw new Error('Missing materials archive')
      },
      load: async () => {
        throw new Error('Missing materials archive')
      }
    })
    assert.ok(report.some(line => /en:.*Missing materials archive/.test(line)))
    assert.ok(report.some(line => /ru:.*Missing materials archive/.test(line)))
  } finally {
    await rm(output, { recursive: true, force: true })
  }
})
