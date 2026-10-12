import assert from 'node:assert/strict'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFragment } from 'parse5'
import { compareScreenshots } from './chrome-store-materials.mjs'
import { readListing, readStoreFile, reportStoreAction } from './store-materials.mjs'

const dashboard = 'https://addons.mozilla.org/developers/addons'
const locales = { en: 'en-US', ru: 'ru' }
const normalize = value => {
  assert.equal(typeof value, 'string', 'Missing published text')
  const text = node =>
    node.nodeName === '#text'
      ? node.value
      : `${['br', 'p', 'div', 'li'].includes(node.nodeName) ? ' ' : ''}${(node.childNodes || []).map(text).join('')}`
  return text(parseFragment(value)).replace(/\s+/gu, ' ').trim()
}

export async function checkFirefoxStoreMaterials({
  tag,
  request = fetch,
  env = process.env,
  output = 'test-results/firefox-store-materials',
  load = async file => (tag ? readStoreFile(tag, file) : readFile(file)),
  listing = async locale =>
    tag
      ? JSON.parse(await load(`store/listings/firefox/${locale}.json`))
      : readListing(`store/listings/firefox/${locale}`)
} = {}) {
  const report = []
  const warn = async message => {
    report.push(`Warning: ${message}`)
    await reportStoreAction('Firefox Add-ons', dashboard, message, { env })
  }
  const get = async url => {
    const address = new URL(url)
    assert.ok(
      address.protocol === 'https:' &&
        address.hostname === 'addons.mozilla.org' &&
        !address.username &&
        !address.password &&
        !address.port,
      'Unexpected public AMO URL'
    )
    const response = await request(address.href, {
      signal: AbortSignal.timeout(15000),
      redirect: 'error'
    })
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
  const image = async (name, file, url) => {
    try {
      const result = await compareScreenshots(await load(file), await get(url))
      if (result.similar) {
        report.push(`${name}: matches`)
      } else {
        await warn(`${name}: published image differs; review and replace it in the dashboard`)
        await mkdir(output, { recursive: true })
        for (const field of ['expected', 'actual', 'difference']) {
          await writeFile(path.join(output, `${name}-${field}.png`), result[field])
        }
      }
    } catch (error) {
      await warn(`${name}: image freshness unknown: ${error.message}; check it manually`)
    }
  }
  try {
    // This unauthenticated endpoint supplies the public listing, including all translations.
    const published = JSON.parse(
      await get('https://addons.mozilla.org/api/v5/addons/addon/megaproxy/')
    )
    assert.equal(published.guid, 'browser-mega-proxy@andre487', 'Unexpected public AMO listing')
    const expected = {}
    for (const [language, locale] of Object.entries(locales)) {
      try {
        expected[language] = await listing(language)
        for (const field of ['name', 'summary', 'description', 'homepage', 'support']) {
          const actual =
            field === 'homepage' || field === 'support'
              ? published[field === 'support' ? 'support_url' : field]?.url?.[locale]
              : published[field]?.[locale]
          if (normalize(expected[language][field]) !== normalize(actual ?? '')) {
            await warn(`${language}: published ${field} differs; update it in the dashboard`)
            await mkdir(output, { recursive: true })
            await writeFile(
              path.join(output, `${language}-${field}-expected.txt`),
              expected[language][field]
            )
            await writeFile(path.join(output, `${language}-${field}-actual.txt`), actual ?? '')
          } else {
            report.push(`${language}: ${field} matches`)
          }
        }
        assert.ok(
          Array.isArray(expected[language].screenshotCaptions) &&
            expected[language].screenshotCaptions.length > 0,
          'Missing expected screenshots'
        )
      } catch (error) {
        delete expected[language]
        await warn(
          `${language}: listing freshness unknown: ${error.message}; check texts and screenshots manually`
        )
      }
    }
    await image('icon', 'store/assets/shared/icon-128.png', published.icon_url)
    assert.ok(Array.isArray(published.previews), 'Missing public gallery')
    const previews = [...published.previews].sort((a, b) => a.position - b.position)
    if (expected.en && expected.ru) {
      const count = expected.en.screenshotCaptions.length + expected.ru.screenshotCaptions.length
      if (previews.length !== count) {
        await warn(
          `Shared screenshot count differs (published ${previews.length}, expected ${count}); keep EN screenshots followed by RU screenshots`
        )
      }
      let position = 0
      for (const language of Object.keys(locales)) {
        for (
          let index = 0;
          index < expected[language].screenshotCaptions.length;
          index++, position++
        ) {
          const name = `${language}-${String(index + 1).padStart(2, '0')}`
          const preview = previews[position]
          if (!preview || preview.position !== position) {
            await warn(
              `${name}: screenshot missing or gallery position differs; fix shared gallery order`
            )
          }
          for (const [captionLanguage, locale] of Object.entries(locales)) {
            if (
              normalize(preview?.caption?.[locale] ?? '') !==
              normalize(expected[captionLanguage].screenshotCaptions[index] ?? '')
            ) {
              await warn(
                `${name}: ${captionLanguage} caption differs; update the localized caption`
              )
            }
          }
          await image(
            name,
            `store/assets/firefox/${language}/${String(index + 1).padStart(2, '0')}.png`,
            preview?.image_url
          )
        }
      }
    }
  } catch (error) {
    await warn(
      `Public listing freshness unknown: ${error.message}; check listing, links, icon and screenshots manually`
    )
  }
  report.push(
    'Checks cover public materials only; dashboard drafts and privacy policy are not verified. Review privacy policy manually when it changes.'
  )
  console.log(report.join('\n'))
  try {
    await mkdir(output, { recursive: true })
    await writeFile(path.join(output, 'report.txt'), `${report.join('\n')}\n`)
    if (env.GITHUB_STEP_SUMMARY) {
      await appendFile(
        env.GITHUB_STEP_SUMMARY,
        `### Firefox Add-ons materials\n\n${report.map(line => `- ${line.replace(/[\r\n]/gu, ' ')}`).join('\n')}\n\n[Developer dashboard](${dashboard})\n`
      )
    }
  } catch (error) {
    await warn(`Could not save materials report: ${error.message}`)
  }
  return report
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkFirefoxStoreMaterials({ tag: process.argv[2] })
}
