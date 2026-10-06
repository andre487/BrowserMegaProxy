import { readFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'

// Render a vector clipping path around the original Android artwork.
// Keep the source logo unchanged; only the toolbar silhouette differs.
const artwork = (await readFile('extension/icons/icon.png')).toString('base64')
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  for (const size of [16, 24, 32, 48]) {
    await page.setViewportSize({ width: size, height: size })
    await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:transparent}svg{display:block}</style>
      <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
        <defs><clipPath id="shape"><rect width="512" height="512" rx="128"/></clipPath></defs>
        <image href="data:image/png;base64,${artwork}" width="512" height="512" clip-path="url(#shape)"/>
      </svg>`)
    await page.locator('svg image').evaluate(async image => {
      const source = new globalThis.Image()
      source.src = image.getAttribute('href')
      await source.decode()
    })
    await page.screenshot({ path: `extension/icons/toolbar${size}.png`, omitBackground: true })
  }
} finally {
  await browser.close()
}
