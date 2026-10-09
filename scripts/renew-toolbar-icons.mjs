import { copyFile, readFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'

// PNGs are required by Chromium; SVGs remain the editable sources.
// All toolbar sizes and icon16/32 use M; the larger main icons use MPX.
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  for (const [source, sizes, prefix] of [
    ['toolbar.svg', [16, 24, 32, 48, 64], 'toolbar'],
    ['icon.svg', [48, 128, 512], 'icon']
  ]) {
    const artwork = await readFile(`extension/icons/${source}`, 'utf8')
    for (const size of sizes) {
      await page.setViewportSize({ width: size, height: size })
      await page.setContent(
        `<style>html,body{margin:0;background:transparent}svg{display:block}</style>${artwork}`
      )
      await page.locator('svg').evaluate((svg, size) => {
        svg.setAttribute('width', size)
        svg.setAttribute('height', size)
        const mark = svg.querySelector('polygon')
        if (mark) {
          // Snap the small M to physical pixels, including the 1.5x version.
          const scale = size / svg.viewBox.baseVal.width
          mark.setAttribute(
            'points',
            [...mark.points]
              .map(point =>
                [point.x, point.y].map(value => Math.round(value * scale) / scale).join(',')
              )
              .join(' ')
          )
        }
      }, size)
      await page.screenshot({
        path: `extension/icons/${prefix}${size === 512 ? '' : size}.png`,
        omitBackground: true
      })
    }
  }
  for (const size of [16, 32]) {
    await copyFile(`extension/icons/toolbar${size}.png`, `extension/icons/icon${size}.png`)
  }
} finally {
  await browser.close()
}
