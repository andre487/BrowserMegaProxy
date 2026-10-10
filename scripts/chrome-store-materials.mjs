import assert from 'node:assert/strict'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'parse5'
import sharp from 'sharp'
import { ssim } from 'ssim.js'
import { readListing, readStoreFile } from './store-materials.mjs'

const dashboard = 'https://chrome.google.com/webstore/devconsole'
const limits = { mean: 0.985, region: 0.94, regionSize: 64, width: 640, blur: 0.8 }
const normalizeText = text => text.replace(/\s+/gu, ' ').trim()

function similarity(images) {
  // Per-channel SSIM also catches color changes with the same luminance.
  return Math.min(
    ...[0, 1, 2].map(
      channel =>
        ssim(
          ...images.map(image => ({
            ...image,
            data: image.data.map((value, i) =>
              i % 4 === 3 ? 255 : image.data[i - (i % 4) + channel]
            )
          })),
          { downsample: false }
        ).mssim
    )
  )
}

export function parsePublicListing(html) {
  const paragraphs = []
  const screenshots = new Map()
  const text = node =>
    node.nodeName === '#text' ? node.value : (node.childNodes || []).map(text).join('')
  const visit = (node, overview = false) => {
    const attrs = Object.fromEntries((node.attrs || []).map(({ name, value }) => [name, value]))
    overview ||= attrs.jsname === 'ij8cu'
    if (overview && node.tagName === 'p') {
      paragraphs.push(text(node))
    }
    if (attrs['data-is-video'] === 'false' && attrs['data-media-url']) {
      const url = new URL(attrs['data-media-url'])
      assert.ok(
        url.protocol === 'https:' && url.hostname === 'lh3.googleusercontent.com',
        'Unexpected screenshot host'
      )
      const index = Number(attrs['data-slide-index'])
      assert.ok(
        Number.isInteger(index) && index >= 0 && index < 5,
        'Unexpected screenshot position'
      )
      assert.ok(
        !screenshots.has(index) || screenshots.get(index) === url.href,
        'Ambiguous screenshot position'
      )
      screenshots.set(index, url.href)
    }
    for (const child of node.childNodes || []) {
      visit(child, overview)
    }
  }
  visit(parse(html))
  assert.ok(
    paragraphs.length === 2 && paragraphs.every(value => value.trim()),
    'Public listing description not found or page layout changed'
  )
  assert.ok(
    screenshots.size > 0 && [...screenshots.keys()].every(index => index < screenshots.size),
    'Public listing screenshots not found or page layout changed'
  )
  return {
    summary: paragraphs[0],
    description: paragraphs[1],
    screenshots: [...screenshots.entries()].sort(([a], [b]) => a - b).map(([, url]) => url)
  }
}

export async function compareScreenshots(expected, actual) {
  const metadata = await Promise.all(
    [expected, actual].map(image => sharp(image, { limitInputPixels: 16000000 }).metadata())
  )
  assert.ok(
    metadata.every(image => image.width && image.height),
    'Missing image dimensions'
  )
  const aspectMatches =
    Math.abs(metadata[0].width / metadata[0].height - metadata[1].width / metadata[1].height) < 0.01
  const width = Math.min(limits.width, metadata[0].width, metadata[1].width)
  const height = Math.round((width * metadata[0].height) / metadata[0].width)
  assert.ok(width >= 64 && height >= 64 && height <= 1024, 'Unexpected screenshot dimensions')
  const images = await Promise.all(
    [expected, actual].map(image =>
      sharp(image, { limitInputPixels: 16000000 })
        .flatten({ background: '#ffffff' })
        .toColourspace('srgb')
        .resize(width, height, { fit: 'contain', background: '#ffffff' })
        .blur(limits.blur)
        .ensureAlpha()
        .raw()
        .toBuffer()
    )
  )
  const mean = similarity(images.map(data => ({ data, width, height })))
  let region = 1
  const rows = Math.ceil(height / limits.regionSize)
  const columns = Math.ceil(width / limits.regionSize)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const top = Math.floor((y * height) / rows)
      const left = Math.floor((x * width) / columns)
      const w = Math.floor(((x + 1) * width) / columns) - left
      const h = Math.floor(((y + 1) * height) / rows) - top
      const crops = images.map(image => {
        const data = Buffer.alloc(w * h * 4)
        for (let row = 0; row < h; row++) {
          image.copy(
            data,
            row * w * 4,
            ((top + row) * width + left) * 4,
            ((top + row) * width + left + w) * 4
          )
        }
        return { data, width: w, height: h }
      })
      region = Math.min(region, similarity(crops))
    }
  }
  const similar = aspectMatches && mean >= limits.mean && region >= limits.region
  const difference = Buffer.alloc(width * height * 4)
  for (let i = 0; i < difference.length; i += 4) {
    const delta = Math.max(
      ...[0, 1, 2].map(channel => Math.abs(images[0][i + channel] - images[1][i + channel]))
    )
    difference[i] = 255
    difference[i + 3] = delta > 20 ? 200 : 0
  }
  const raw = { width, height, channels: 4 }
  return {
    similar,
    mean,
    region,
    expected: await sharp(images[0], { raw }).png().toBuffer(),
    actual: await sharp(images[1], { raw }).png().toBuffer(),
    difference: await sharp(images[0], { raw })
      .composite([{ input: difference, raw }])
      .png()
      .toBuffer()
  }
}

export async function checkChromeStoreMaterials({
  tag,
  extensionId = process.env.CWS_EXTENSION_ID || 'kfilelfnldddoncicbampiojjjcpbigo',
  request = fetch,
  env = process.env,
  output = 'test-results/chrome-store-materials',
  load = async file => (tag ? readStoreFile(tag, file) : readFile(file)),
  listing = async locale =>
    tag
      ? JSON.parse(await load(`store/listings/chrome/${locale}.json`))
      : readListing(`store/listings/chrome/${locale}`)
} = {}) {
  const report = []
  const warn = message => {
    report.push(`Warning: ${message}`)
    console.warn(
      `::warning title=Chrome Web Store materials::${message.replace(/%/gu, '%25').replace(/\r/gu, '%0D').replace(/\n/gu, '%0A')}`
    )
  }
  const get = async url => {
    const response = await request(url, { signal: AbortSignal.timeout(15000) })
    assert.ok(response.ok, `HTTP ${response.status}`)
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      assert.ok(size <= 8 * 1024 * 1024, 'Response exceeds size limit')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }
  try {
    assert.match(extensionId, /^[a-p]{32}$/u, 'Invalid Chrome Web Store extension ID')
    for (const locale of ['en', 'ru']) {
      try {
        const expected = await listing(locale)
        const publicListing = parsePublicListing(
          (
            await get(`https://chromewebstore.google.com/detail/${extensionId}?hl=${locale}`)
          ).toString('utf8')
        )
        for (const field of ['summary', 'description']) {
          assert.equal(typeof expected[field], 'string', `Missing expected ${field}`)
          if (normalizeText(expected[field]) !== normalizeText(publicListing[field])) {
            warn(`${locale}: published ${field} differs; synchronize it in the developer dashboard`)
            await mkdir(output, { recursive: true })
            await writeFile(path.join(output, `${locale}-${field}-expected.txt`), expected[field])
            await writeFile(
              path.join(output, `${locale}-${field}-actual.txt`),
              publicListing[field]
            )
          } else {
            report.push(`${locale}: ${field} matches`)
          }
        }
        assert.ok(
          Array.isArray(expected.screenshotCaptions) && expected.screenshotCaptions.length > 0,
          'Missing expected screenshot count'
        )
        if (publicListing.screenshots.length !== expected.screenshotCaptions.length) {
          warn(
            `${locale}: screenshot count differs (published ${publicListing.screenshots.length}, expected ${expected.screenshotCaptions.length})`
          )
        }
        for (
          let i = 0;
          i < Math.min(publicListing.screenshots.length, expected.screenshotCaptions.length);
          i++
        ) {
          const name = `${locale}-${String(i + 1).padStart(2, '0')}`
          try {
            const expectedImage = await load(
              `store/assets/chromium/${locale}/${String(i + 1).padStart(2, '0')}.png`
            )
            const actualImage = await get(`${publicListing.screenshots[i].split('=')[0]}=s0`)
            const result = await compareScreenshots(expectedImage, actualImage)
            const scores = `SSIM ${result.mean.toFixed(4)}, worst region ${result.region.toFixed(4)}`
            if (result.similar) {
              report.push(`${name}: screenshot matches (${scores})`)
            } else {
              warn(
                `${name}: published screenshot differs (${scores}); review and replace it if needed`
              )
              await mkdir(output, { recursive: true })
              for (const field of ['expected', 'actual', 'difference']) {
                await writeFile(path.join(output, `${name}-${field}.png`), result[field])
              }
            }
          } catch (error) {
            warn(`${name}: screenshot freshness unknown: ${error.message}`)
          }
        }
      } catch (error) {
        warn(`${locale}: listing freshness unknown: ${error.message}`)
      }
    }
  } catch (error) {
    warn(`Listing freshness unknown: ${error.message}`)
  }
  report.push(
    'Checks cover the published listing only; dashboard drafts, privacy fields and promotional tiles are not verified.'
  )
  console.log(report.join('\n'))
  try {
    await mkdir(output, { recursive: true })
    await writeFile(path.join(output, 'report.txt'), `${report.join('\n')}\n`)
    if (env.GITHUB_STEP_SUMMARY) {
      await appendFile(
        env.GITHUB_STEP_SUMMARY,
        `### Chrome Web Store materials\n\n${report.map(line => `- ${line.replace(/[\r\n]/gu, ' ')}`).join('\n')}\n\n[Developer dashboard](${dashboard})\n`
      )
    }
  } catch (error) {
    warn(`Could not save materials report: ${error.message}`)
  }
  return report
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) {
    console.log(
      'Usage: npm run store:check:chrome -- [vX.Y.Z]\nWithout a tag, compare repository materials. With a tag, read dist/release/MegaProxy-store-materials-vX.Y.Z.zip. Set CWS_EXTENSION_ID to select the item. Warnings never stop publication. Reports: test-results/chrome-store-materials/.'
    )
  } else {
    await checkChromeStoreMaterials({ tag: process.argv[2] })
  }
}
