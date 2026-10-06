import http from 'node:http'
import https from 'node:https'
import { readFileSync } from 'node:fs'

const requests = []
function respond(req, res) {
  if (req.url === '/__requests') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(requests))
    return
  }
  requests.push({
    host: req.headers.host,
    path: req.url,
    headers: req.headers,
    remoteAddress: req.socket.remoteAddress
  })
  const host = req.headers.host.split(':')[0]
  res.setHeader('Connection', 'close')
  res.setHeader('Cache-Control', 'no-store')
  if (host === 'raw.githubusercontent.com') {
    res.end('subscription.invalid\nchild.subscription.invalid\n192.168.0.1\n')
  } else if (['ifconfig.me', 'api.ipify.org', 'icanhazip.com'].includes(host)) {
    res.end('203.0.113.7')
  } else if (['ifconfig.co', 'ipapi.co'].includes(host)) {
    res.end('US')
  } else if (host === 'api.country.is') {
    res.end('{"country":"US"}')
  } else if (req.url === '/split') {
    res.setHeader('Content-Type', 'text/html')
    res.end('<p>MegaProxyServer origin</p><img src="https://cdn.invalid/resource">')
  } else if (req.url === '/resource') {
    res.setHeader('Content-Type', 'image/svg+xml')
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>')
  } else {
    res.end('MegaProxyServer origin')
  }
}
http.createServer(respond).listen(80, '0.0.0.0')
https
  .createServer(
    { key: readFileSync('/fixture/privkey.pem'), cert: readFileSync('/fixture/fullchain.pem') },
    respond
  )
  .listen(443, '0.0.0.0')
