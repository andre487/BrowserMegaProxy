import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import {
  checkChromeStoreMaterials,
  compareScreenshots,
  parsePublicListing
} from '../scripts/chrome-store-materials.mjs'

const page = (
  description = 'Description &amp; details',
  images = [0, 1]
) => `<!doctype html><html><body>
  <img src="https://lh3.googleusercontent.com/unrelated">
  <div jsname="ij8cu"><p>Summary</p><p>${description}</p></div>
  ${[...images]
    .reverse()
    .concat(images)
    .map(
      index =>
        `<div data-is-video="false" data-slide-index="${index}" data-media-url="https://lh3.googleusercontent.com/screenshot${index}"></div>`
    )
    .join('')}
</body></html>`

test('public listing parser decodes entities and preserves gallery positions despite carousel clones', () => {
  assert.deepEqual(parsePublicListing(page()), {
    summary: 'Summary',
    description: 'Description & details',
    screenshots: [
      'https://lh3.googleusercontent.com/screenshot0',
      'https://lh3.googleusercontent.com/screenshot1'
    ]
  })
  assert.throws(() => parsePublicListing('<h1>Sign in</h1>'), /description not found/)
  assert.throws(
    () => parsePublicListing(page().replaceAll('lh3.googleusercontent.com', 'untrusted.example')),
    /Unexpected screenshot host/
  )
  assert.throws(() => parsePublicListing(page('Description', [1])), /screenshots not found/)
})

test('SSIM accepts compression and resizing but detects a small UI change hidden by the overall score', async () => {
  const original = await readFile('store/assets/chromium/en/01.png')
  for (let i = 1; i <= 5; i++) {
    const screenshot = await readFile(`store/assets/chromium/en/0${i}.png`)
    for (const image of [
      screenshot,
      await sharp(screenshot).jpeg({ quality: 85 }).toBuffer(),
      await sharp(screenshot).resize(640, 400).webp({ quality: 90 }).toBuffer()
    ]) {
      const result = await compareScreenshots(screenshot, image)
      assert.ok(result.similar, `Screenshot ${i}: mean ${result.mean}, region ${result.region}`)
    }
  }
  const patch = await sharp({
    create: { width: 36, height: 24, channels: 4, background: '#ff0000' }
  })
    .png()
    .toBuffer()
  const changed = await sharp(original)
    .composite([{ input: patch, top: 120, left: 120 }])
    .png()
    .toBuffer()
  const result = await compareScreenshots(original, changed)
  assert.ok(result.mean >= 0.985, `Mean ${result.mean}`)
  assert.ok(!result.similar, `Region ${result.region}`)
  assert.equal((await sharp(result.difference).metadata()).width, 640)
  const distorted = await sharp(original).resize(640, 640, { fit: 'fill' }).png().toBuffer()
  assert.ok(!(await compareScreenshots(original, distorted)).similar)
  await assert.rejects(compareScreenshots(original, Buffer.from('Not an image')))
  const colorImage = color =>
    sharp({ create: { width: 128, height: 128, channels: 3, background: color } })
      .png()
      .toBuffer()
  assert.ok(
    !(await compareScreenshots(await colorImage('#ff0000'), await colorImage('#008200'))).similar
  )
})

test('materials comparison normalizes whitespace, reports differences and continues after each failed fetch', async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'chrome-materials-'))
  const original = await readFile('store/assets/chromium/en/01.png')
  const changed = await sharp(original).negate().png().toBuffer()
  const calls = []
  try {
    const report = await checkChromeStoreMaterials({
      output,
      env: { GITHUB_STEP_SUMMARY: path.join(output, 'summary.md') },
      listing: async locale => ({
        summary: 'Summary',
        description: locale === 'en' ? 'Description\n & details' : 'New description',
        screenshotCaptions: ['One', 'Two']
      }),
      load: async () => original,
      request: async (url, options) => {
        assert.ok(options.signal instanceof AbortSignal)
        calls.push(url)
        if (url.includes('?hl=')) {
          return new Response(page())
        }
        if (url.endsWith('screenshot0=s0') && calls.length < 5) {
          return new Response('Unavailable', { status: 503 })
        }
        return new Response(url.endsWith('screenshot1=s0') ? changed : original)
      }
    })
    assert.ok(report.includes('en: description matches'))
    assert.ok(report.some(line => /en-01: screenshot freshness unknown:.*503/u.test(line)))
    assert.ok(report.some(line => /en-02: published screenshot differs/u.test(line)))
    assert.ok(report.some(line => /ru: published description differs/u.test(line)))
    assert.ok(report.some(line => /ru-01: screenshot matches/u.test(line)))
    assert.equal(calls.length, 6)
    assert.ok((await readFile(path.join(output, 'en-02-difference.png'))).length > 0)
    assert.match(await readFile(path.join(output, 'summary.md'), 'utf8'), /Developer dashboard/)
    assert.match(await readFile(path.join(output, 'report.txt'), 'utf8'), /published listing only/)
  } finally {
    await rm(output, { recursive: true, force: true })
  }
})

test('network, parser, archive, decode and report failures remain warnings and do not stop other locales', async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'chrome-materials-'))
  try {
    for (const request of [
      async () => {
        throw new Error('Network down')
      },
      async () => new Response('Unavailable', { status: 404 }),
      async () => new Response('<html>New layout</html>'),
      async url => new Response(url.includes('?hl=') ? page() : 'Broken PNG')
    ]) {
      const report = await checkChromeStoreMaterials({
        output,
        env: {},
        request,
        listing: async () => ({
          summary: 'Summary',
          description: 'Description & details',
          screenshotCaptions: ['One', 'Two']
        }),
        load: async () => Buffer.from('Broken PNG')
      })
      assert.ok(report.some(line => line.startsWith('Warning: en')))
      assert.ok(report.some(line => line.startsWith('Warning: ru')))
    }
    const report = await checkChromeStoreMaterials({
      output,
      env: {},
      tag: 'v0.1.1',
      load: async () => {
        throw new Error('Missing materials archive')
      }
    })
    assert.ok(report.some(line => /en.*Missing materials archive/u.test(line)))
    assert.ok(report.some(line => /ru.*Missing materials archive/u.test(line)))
    const saveFailure = await checkChromeStoreMaterials({
      output: path.join(output, 'report.txt'),
      env: {},
      extensionId: 'invalid'
    })
    assert.ok(saveFailure.some(line => /Could not save materials report/u.test(line)))
  } finally {
    await rm(output, { recursive: true, force: true })
  }
})

test('Chrome CLI still uploads and submits the package when released materials are unavailable', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chrome-publication-'))
  const script = fileURLToPath(new URL('../scripts/chrome-web-store.mjs', import.meta.url))
  try {
    await mkdir(path.join(directory, 'dist/release'), { recursive: true })
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ version: '0.1.1' }))
    execFileSync('zip', ['-q', 'dist/release/MegaProxy-chromium-v0.1.1.zip', 'manifest.json'], {
      cwd: directory
    })
    const code = `
      process.argv[1] = ${JSON.stringify(script)};
      process.argv[2] = 'v0.1.1';
      globalThis.fetch = async url => {
        if (url.includes('oauth2')) return Response.json({ access_token: 'token' });
        if (url.endsWith(':fetchStatus')) return Response.json({});
        if (url.endsWith(':upload')) return Response.json({ uploadState: 'SUCCEEDED' });
        if (url.endsWith(':publish')) return Response.json({ state: 'PENDING_REVIEW' });
        throw new Error('Unexpected request');
      };
      await import(${JSON.stringify(new URL('../scripts/chrome-web-store.mjs', import.meta.url).href)});
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: path.join(directory, 'summary.md'),
        CWS_PUBLISHER_ID: 'publisher',
        CWS_EXTENSION_ID: 'kfilelfnldddoncicbampiojjjcpbigo',
        CWS_CLIENT_ID: 'client',
        CWS_CLIENT_SECRET: 'secret',
        CWS_REFRESH_TOKEN: 'refresh',
        CWS_DRY_RUN: 'false'
      }
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /PENDING_REVIEW/u)
    assert.match(result.stderr, /en: listing freshness unknown/u)
    assert.match(result.stderr, /ru: listing freshness unknown/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
