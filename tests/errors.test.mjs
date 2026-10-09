import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import '../extension/errors.js'

const { details, context, format } = globalThis.MegaErrors

test('errors retain operation, safe browser cause, HTTP status and resource across serialization', async () => {
  const error = context(
    Object.assign(new Error('errorIcon', { cause: new TypeError('Failed to fetch') }), {
      resource: 'toolbar32.png'
    }),
    'toolbarIcon'
  )
  assert.deepEqual(details(error), {
    operation: 'toolbarIcon',
    code: 'errorIcon',
    reason: 'errorNetwork',
    resource: 'toolbar32.png'
  })
  const transferred = {
    error: error.message,
    errorDetails: JSON.parse(JSON.stringify(details(error)))
  }
  for (const locale of ['ru', 'en']) {
    const catalog = JSON.parse(await readFile(`extension/_locales/${locale}/messages.json`, 'utf8'))
    const t = key => catalog[key]?.message || key
    const text = format(transferred, 'get', t)
    assert.ok(text.startsWith(catalog.operationToolbarIcon.message))
    assert.ok(text.includes(catalog.errorNetwork.message))
    assert.ok(text.includes('toolbar32.png'))
    assert.ok(!text.includes('Failed to fetch'))
    assert.ok(
      format(new Error('net::ERR_NAME_NOT_RESOLVED'), 'request', t).includes(
        catalog.reasonERR_NAME_NOT_RESOLVED.message
      )
    )
    assert.ok(
      format(new Error('splitUnsupportedWarning'), 'import', t).includes(
        catalog.splitUnsupportedWarning.message
      )
    )
  }
  assert.deepEqual(
    details(
      Object.assign(new Error('errorConfigDownload', { cause: new Error('errorHTTP') }), {
        status: 503
      }),
      'fetchConfig'
    ),
    {
      operation: 'fetchConfig',
      code: 'errorConfigDownload',
      reason: 'errorHTTP',
      status: 503
    }
  )
  assert.equal(details(new DOMException('secret', 'TimeoutError'), 'check').reason, 'TimeoutError')
  assert.equal(
    details(new Error('QUOTA_BYTES limit exceeded'), 'sync').reason,
    'QuotaExceededError'
  )
  assert.equal(
    details(new Error('Could not establish connection. Receiving end does not exist.'), 'get').code,
    'errorBackground'
  )
  const secret = details(
    {
      message: 'https://user:private-secret@example.com/?token=private-token',
      reason: 'private-password',
      operation: 'private-operation',
      status: 999,
      resource: 'private-file'
    },
    'save'
  )
  assert.deepEqual(secret, { operation: 'save', code: 'errorUnexpected' })
})

test('5xx response diagnostics read bounded JSON/HTML, redact credentials and survive UI serialization', async () => {
  const secrets = ['private-session', 'private-token']
  for (const body of [
    JSON.stringify({
      error: 'upstream unavailable',
      password: 'unknown-password',
      token: 'private-token',
      trace: 'private-session'
    }),
    '<html>upstream unavailable; sessionid=private-session; Authorization: Bearer private-token; https://user:pass@example.org/?key=private-token</html>'
  ]) {
    const error = await globalThis.MegaErrors.httpError(
      new Response(body, { status: 503 }),
      'errorHTTP',
      secrets
    )
    const transferred = JSON.parse(JSON.stringify(details(context(error, 'fetchConfig'))))
    assert.equal(transferred.status, 503)
    assert.match(transferred.responseBody, /upstream unavailable/)
    assert.doesNotMatch(
      transferred.responseBody,
      /private-session|private-token|unknown-password|https:\/\//
    )
    assert.match(
      format({ errorDetails: transferred }, 'fetchConfig', key => key),
      /upstream unavailable/
    )
  }
  const reader = {
    read: async () => ({ done: false, value: new TextEncoder().encode('x'.repeat(20000)) }),
    cancel: async () => {
      reader.cancelled = true
    }
  }
  const limited = await globalThis.MegaErrors.httpError(
    { status: 500, body: { getReader: () => reader } },
    'Server HTTP 500'
  )
  assert.ok(reader.cancelled)
  assert.ok(limited.responseBody.length <= 4096)
  assert.match(limited.message, /truncated/)
  const broken = await globalThis.MegaErrors.httpError({
    status: 502,
    text: async () => {
      throw new Error('secret')
    }
  })
  assert.equal(broken.status, 502)
  assert.equal(broken.responseBody, '[response body unavailable]')
  const empty = await globalThis.MegaErrors.httpError(new Response('', { status: 599 }))
  assert.equal(empty.responseBody, '[empty response body]')
  const denied = await globalThis.MegaErrors.httpError({
    status: 403,
    text: () => assert.fail('Do not read 4xx bodies')
  })
  assert.equal(denied.responseBody, undefined)
  assert.doesNotMatch(
    globalThis.MegaErrors.responseText('trace: private-sess', secrets),
    /private-sess/
  )
})
