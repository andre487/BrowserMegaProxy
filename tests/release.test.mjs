import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  generateNotes,
  prepareStoreMaterials,
  responseNotes,
  validateVersion
} from '../scripts/release.mjs'

test('release versions are browser-compatible and preparation accepts an unreleased current version but cannot downgrade', () => {
  for (const value of ['0.0.1', '0.1.0', '1.2.3', '65535.65535.65535']) {
    assert.equal(validateVersion(value), value)
  }
  for (const value of [
    'v1.2.3',
    '1.2',
    '1.2.3.4',
    '01.2.3',
    '1.2.3-beta',
    '65536.1.0',
    '0.0.0',
    '1.2.3\n',
    '1.2.3; echo bad'
  ]) {
    assert.throws(() => validateVersion(value), value)
  }
  for (const value of ['0.0.9', '0.0.1']) {
    assert.throws(() => validateVersion(value, '0.1.0'), value)
  }
  assert.equal(validateVersion('0.1.0', '0.1.0'), '0.1.0')
  assert.equal(validateVersion('0.1.1', '0.1.0'), '0.1.1')
  assert.equal(validateVersion('1.0.0', '0.99.99'), '1.0.0')
})

test('release notes use the selected model and reject incomplete, refused or invalid API output', async () => {
  const completed = notes => ({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(notes) }] }]
  })
  const notes = { en: '- Added proxy settings.', ru: '- Добавлены настройки прокси.' }
  const options = {
    apiKey: 'test-key',
    model: 'gpt-6.1-sol',
    history: 'Add proxy settings',
    stat: '1 file',
    previous: null
  }
  let calls = 0
  assert.deepEqual(
    await generateNotes('0.1.1', options, async (url, request) => {
      calls++
      assert.equal(url, 'https://api.openai.com/v1/responses')
      assert.equal(request.headers.Authorization, 'Bearer test-key')
      const body = JSON.parse(request.body)
      assert.equal(body.model, options.model)
      assert.equal(body.store, false)
      assert.equal(body.text.format.strict, true)
      assert.equal(JSON.parse(body.input).history, options.history)
      return { ok: true, json: async () => completed(notes) }
    }),
    notes
  )
  assert.equal(calls, 1)
  assert.throws(() => responseNotes({ ...completed(notes), status: 'incomplete' }))
  assert.throws(() =>
    responseNotes({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'refusal' }] }]
    })
  )
  for (const invalid of [
    { en: '', ru: notes.ru },
    { en: notes.en },
    { ...notes, extra: 'bad' },
    { en: 'a'.repeat(4001), ru: notes.ru },
    { en: notes.en, ru: 'English only' },
    { en: 'Bad\u0000text', ru: notes.ru }
  ]) {
    assert.throws(() => responseNotes(completed(invalid)))
  }
  await assert.rejects(
    generateNotes('0.1.1', options, async () => ({ ok: false, status: 401 })),
    /HTTP 401/
  )
  await assert.rejects(
    generateNotes('0.1.1', options, async () => {
      throw new Error('Network failure')
    }),
    /Network failure/
  )
  await assert.rejects(
    generateNotes('0.1.1', { ...options, apiKey: '' }, () =>
      assert.fail('No request without credentials')
    )
  )
  await assert.rejects(
    generateNotes('0.1.1', { ...options, history: 'a'.repeat(100001) }, () =>
      assert.fail('No request for oversized history')
    )
  )
})

test('store material generation preserves assets and renders all localized listings as Markdown', async () => {
  const destination = await mkdtemp(path.join(tmpdir(), 'mega-store-materials-'))
  try {
    await prepareStoreMaterials(destination)
    for (const shop of ['chrome', 'firefox', 'opera']) {
      for (const locale of ['en', 'ru']) {
        const file = path.join('store', 'listings', shop, locale)
        const listing = JSON.parse(await readFile(`${file}.json`, 'utf8'))
        const markdown = await readFile(path.join(destination, `${file}.md`), 'utf8')
        assert.ok(markdown.includes(listing.summary))
        assert.ok(markdown.includes(listing.description.replace(/^• /gm, '- ')))
        assert.ok(markdown.includes(listing.homepage))
        assert.ok(markdown.includes(listing.support))
        for (const caption of listing.screenshotCaptions) {
          assert.ok(markdown.includes(caption))
        }
      }
    }
    const asset = 'store/assets/shared/icon-128.png'
    assert.deepEqual(await readFile(path.join(destination, asset)), await readFile(asset))
  } finally {
    await rm(destination, { recursive: true, force: true })
  }
})
