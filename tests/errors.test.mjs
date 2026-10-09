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
