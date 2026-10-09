import { readFile } from 'node:fs/promises'
import http from 'node:http'

const types = {
  html: 'text/html',
  js: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  png: 'image/png',
  svg: 'image/svg+xml'
}
http
  .createServer(async (req, res) => {
    const file = req.url.split('?')[0].slice(1) || 'popup.html'
    if (
      !/^(?:[a-z0-9-]+\.(?:html|js|css)|icons\/(?:icon(?:16|32|48|128)?|toolbar(?:16|24|32|48|64))\.png|icons\/icon\.svg|_locales\/(?:en|ru)\/messages\.json)$/.test(
        file
      )
    ) {
      res.writeHead(404).end()

      return
    }

    try {
      res.setHeader('Content-Type', types[file.split('.').at(-1)])
      res.end(await readFile(`dist/chromium/${file}`))
    } catch {
      res.writeHead(404).end()
    }
  })
  .listen(8765, '127.0.0.1')
