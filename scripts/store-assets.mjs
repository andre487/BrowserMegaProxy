/* global document, window, location, Image */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium, firefox } from '@playwright/test'

const logo = `data:image/png;base64,${(await readFile('extension/icons/icon.png')).toString('base64')}`
const copy = {
  en: [
    ['Your proxy. Your choice.', 'Switch profiles from the toolbar.', 'Profiles and quick actions'],
    [
      'A clear view of your connection.',
      'Check your exit IP, country and HTTPS load time.',
      'Connection and profiles'
    ],
    ['Choose what uses your proxy.', 'Match domains and their subdomains.', 'Routing rules'],
    [
      'Lists that stay up to date.',
      'Choose domain lists and update them through your proxy.',
      'Automatic domain lists'
    ],
    [
      'See what needs attention.',
      'Inspect failed requests and add their domains to your rules.',
      'Local network monitor'
    ]
  ],
  ru: [
    [
      'Ваш прокси. Ваш выбор.',
      'Переключайте профили прямо из панели браузера.',
      'Профили и быстрые действия'
    ],
    [
      'Подключение под контролем.',
      'Проверяйте внешний IP, страну и время загрузки HTTPS.',
      'Подключение и профили'
    ],
    [
      'Выбирайте, что идёт через прокси.',
      'Правила для доменов и их поддоменов.',
      'Правила маршрутизации'
    ],
    [
      'Списки, которые обновляются.',
      'Выбирайте списки доменов и обновляйте их через прокси.',
      'Автоматические списки'
    ],
    [
      'Ошибки на виду.',
      'Просматривайте неудачные запросы и добавляйте домены в правила.',
      'Локальный монитор сети'
    ]
  ]
}

// Render the existing UI with isolated demo data; never use a real browser profile.
async function demo(page, target, language, theme, strategy) {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    assert.equal(
      url.hostname,
      'megaproxy.local',
      'Store generation must not access external services'
    )
    const file = url.pathname.slice(1)
    assert.match(
      file,
      /^(?:[\w-]+\.(?:html|js|css)|icons\/\w+\.png|_locales\/(en|ru)\/messages\.json)$/
    )
    const types = {
      html: 'text/html',
      js: 'text/javascript',
      css: 'text/css',
      json: 'application/json',
      png: 'image/png'
    }
    await route.fulfill({
      contentType: types[file.split('.').at(-1)],
      body: await readFile(`dist/${target}/${file}`)
    })
  })
  await page.addInitScript(
    ({ language, theme, strategy }) => {
      let state
      const stats = { completed: 1248, failed: 3 }
      const api = {
        i18n: { getUILanguage: () => language },
        tabs: {
          getCurrent: async () => null,
          query: async () => [{ id: 1, title: 'Example website', url: 'https://example.com/' }]
        },
        storage: { onChanged: { addListener() {} } },
        runtime: {
          getURL: path => new URL(path, location.href).href,
          sendMessage: async ({ command }) => {
            const M = globalThis.MegaProxy
            state ||= {
              ...M.defaults(),
              language,
              theme,
              activeId: 'work',
              profiles: [
                M.profile({
                  id: 'work',
                  name: language === 'ru' ? 'Работа' : 'Work',
                  host: 'work.proxy.example',
                  port: 443,
                  color: 5,
                  countryCode: 'DE'
                }),
                M.profile({
                  id: 'personal',
                  name: language === 'ru' ? 'Личный' : 'Personal',
                  host: 'home.proxy.example',
                  port: 443,
                  color: 2,
                  countryCode: 'NL'
                }),
                M.profile({
                  id: 'travel',
                  name: language === 'ru' ? 'Поездки' : 'Travel',
                  host: 'travel.proxy.example',
                  port: 443,
                  color: 6,
                  countryCode: 'US'
                })
              ],
              browserRouting: M.routing({
                enabled: strategy !== 'all',
                strategy: strategy === 'all' ? 'manual' : strategy,
                domains: ['**.example.com', '**.example.org'],
                sites: ['**.example.com'],
                subscriptions: {
                  domainSources: ['youtube', 'discord'],
                  siteSources: [],
                  autoUpdate: true,
                  throughProxy: true
                }
              })
            }
            if (command === 'currentSite') {
              return {
                ok: true,
                currentSite: { hostname: 'example.com', proxied: true, profileId: 'work' }
              }
            }
            if (command === 'check') {
              return {
                ok: true,
                connectionCheck: {
                  stage: 'complete',
                  mode: 'proxy',
                  profileId: 'work',
                  exitIp: '203.0.113.42',
                  countryCode: 'DE',
                  latencyMs: 236
                }
              }
            }
            if (command === 'network') {
              return {
                ok: true,
                entries: [
                  {
                    domain: 'cdn.example.org',
                    type: 'script',
                    failed: true,
                    error: 'net::ERR_CONNECTION_TIMED_OUT',
                    profileId: 'work'
                  },
                  {
                    domain: 'images.example.net',
                    type: 'image',
                    failed: true,
                    status: 503,
                    profileId: 'work'
                  }
                ]
              }
            }
            return {
              ok: true,
              state,
              statistics: stats,
              syncOptions: { enabled: true, includePasswords: true }
            }
          }
        }
      }
      globalThis.chrome = api
      // Firefox uses the same API contract but the actual Firefox-specific UI policy.
      if (globalThis.browser) {
        globalThis.browser = api
      }
    },
    { language, theme, strategy }
  )
}

async function canvas(page, width, height, draw) {
  const png = await page.evaluate(
    async ({ width, height, draw, logo }) => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d', { alpha: draw.kind === 'icon' })
      const image = new Image()
      image.src = logo
      await image.decode()
      const drawLogo = (x, y, size) => {
        ctx.save()
        ctx.beginPath()
        ctx.roundRect(x, y, size, size, size * 0.2)
        ctx.clip()
        ctx.drawImage(image, x, y, size, size)
        ctx.restore()
      }
      if (draw.kind === 'icon') {
        const padding = width / 8
        drawLogo(padding, padding, width - padding * 2)
      } else {
        const gradient = ctx.createLinearGradient(0, 0, width, height)
        gradient.addColorStop(0, '#10283f')
        gradient.addColorStop(0.55, '#19204e')
        gradient.addColorStop(1, '#481669')
        ctx.fillStyle = gradient
        ctx.fillRect(0, 0, width, height)
        if (draw.kind === 'promo') {
          const size = height * 0.55
          drawLogo((width - size) / 2, (height - size) / 2, size)
          ctx.strokeStyle = '#82baff55'
          ctx.lineWidth = 2
          for (const scale of [0.75, 1.15, 1.55]) {
            ctx.beginPath()
            ctx.ellipse(
              width / 2,
              height / 2,
              height * scale,
              (height * scale) / 2,
              -0.25,
              0,
              2 * Math.PI
            )
            ctx.stroke()
          }
        } else {
          drawLogo(44, 48, 54)
          ctx.fillStyle = '#fff'
          ctx.font = 'bold 27px system-ui'
          ctx.fillText('MegaProxy', 114, 83)
          const wrap = (text, x, y, maxWidth, lineHeight) => {
            let line = ''
            for (const word of text.split(' ')) {
              if (line && ctx.measureText(`${line} ${word}`).width > maxWidth) {
                ctx.fillText(line, x, y)
                y += lineHeight
                line = word
              } else {
                line += (line ? ' ' : '') + word
              }
            }
            ctx.fillText(line, x, y)
            return y + lineHeight
          }
          ctx.fillStyle = '#a8c7fa'
          ctx.font = 'bold 17px system-ui'
          ctx.fillText(draw.label, 44, 194)
          ctx.fillStyle = '#fff'
          ctx.font = 'bold 43px system-ui'
          const bottom = wrap(draw.title, 44, 274, 400, 54)
          ctx.fillStyle = '#c5cce1'
          ctx.font = '24px system-ui'
          wrap(draw.subtitle, 44, bottom + 28, 400, 34)
          ctx.font = '15px system-ui'
          ctx.fillText(
            draw.language === 'ru' ? 'Демонстрационная конфигурация' : 'Demo configuration',
            44,
            752
          )
          const shot = new Image()
          shot.src = draw.shot
          await shot.decode()
          ctx.save()
          ctx.shadowColor = '#0007'
          ctx.shadowBlur = 30
          ctx.fillStyle = '#202124'
          ctx.fillRect(510, 28, 728, 744)
          ctx.restore()
          const scale = Math.min(728 / shot.width, 744 / shot.height)
          const w = shot.width * scale
          const h = shot.height * scale
          ctx.drawImage(shot, 510 + (728 - w) / 2, 28 + (744 - h) / 2, w, h)
        }
      }
      document.body.style.margin = '0'
      canvas.style.display = 'block'
      document.body.replaceChildren(canvas)
      return canvas.toDataURL('image/png').split(',')[1]
    },
    { width, height, draw, logo }
  )
  const buffer =
    draw.kind === 'icon' ? Buffer.from(png, 'base64') : await page.locator('canvas').screenshot()
  assert.equal(buffer.readUInt32BE(16), width)
  assert.equal(buffer.readUInt32BE(20), height)
  assert.equal(buffer[25], draw.kind === 'icon' ? 6 : 2, 'Only icons may have transparency')
  return buffer
}

const designer = await chromium.launch()
try {
  const graphics = await designer.newPage()
  await mkdir('store/assets/shared', { recursive: true })
  await writeFile('store/assets/shared/LICENSE', await readFile('extension/icons/LICENSE'))
  for (const size of [64, 128]) {
    await writeFile(
      `store/assets/shared/icon-${size}.png`,
      await canvas(graphics, size, size, { kind: 'icon' })
    )
  }
  for (const [width, height, name] of [
    [440, 280, 'promo-small'],
    [1400, 560, 'promo-marquee']
  ]) {
    await writeFile(
      `store/assets/shared/${name}.png`,
      await canvas(graphics, width, height, { kind: 'promo' })
    )
  }
  for (const target of ['chromium', 'firefox']) {
    const browser = target === 'chromium' ? designer : await firefox.launch()
    try {
      for (const language of ['en', 'ru']) {
        const dir = `store/assets/${target}/${language}`
        await mkdir(dir, { recursive: true })
        for (let i = 0; i < 5; i++) {
          const page = await browser.newPage({
            viewport: { width: 728, height: 744 },
            deviceScaleFactor: 2
          })
          const strategy =
            i === 3
              ? 'lists'
              : i === 2 && target === 'firefox'
                ? 'tabs'
                : i === 0 || i === 1
                  ? 'all'
                  : 'manual'
          await demo(page, target, language, [1, 4].includes(i) ? 'light' : 'dark', strategy)
          const errors = []
          page.on('pageerror', error => errors.push(error.message))
          await page.goto(`http://megaproxy.local/${i === 0 ? 'popup' : 'options'}.html`)
          await page.locator('body:not([hidden])').waitFor()
          if (i === 1) {
            await page.locator('#check').click()
          }
          if (i === 2 || i === 3) {
            await page.locator('#routing-settings > summary').click()
            await page
              .locator('#routing-settings')
              .evaluate(element =>
                window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 24)
              )
          }
          if (i === 4) {
            await page.locator('#network-panel > summary').click()
            await page.locator('.network-row').first().waitFor()
            await page.locator('#network-failed').uncheck()
            await page
              .locator('#network-panel')
              .evaluate(element =>
                window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 24)
              )
          }
          await page.evaluate(() => document.fonts.ready)
          assert.deepEqual(errors, [], `${target}/${language} screenshot ${i + 1}`)
          assert.equal(await page.locator('#notice').textContent(), '')
          const screenshot =
            i === 0 ? await page.locator('main').screenshot() : await page.screenshot()
          const shot = `data:image/png;base64,${screenshot.toString('base64')}`
          const [title, defaultSubtitle, label] = copy[language][i]
          let subtitle = defaultSubtitle
          if (i === 2 && target === 'firefox') {
            subtitle =
              language === 'ru'
                ? 'В Firefox прокси можно включать для отдельных вкладок.'
                : 'In Firefox, enable your proxy for individual tabs.'
          }
          await writeFile(
            `${dir}/0${i + 1}.png`,
            await canvas(graphics, 1280, 800, {
              kind: 'screenshot',
              title,
              subtitle,
              label,
              shot,
              language
            })
          )
          await page.close()
        }
      }
    } finally {
      if (browser !== designer) {
        await browser.close()
      }
    }
  }
} finally {
  await designer.close()
}
console.log('Store assets generated: Chrome / Opera (chromium), Firefox, en / ru.')
