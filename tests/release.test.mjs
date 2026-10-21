import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readListing } from '../scripts/store-materials.mjs'
import {
  generateNotes,
  selectPreviousRelease,
  releaseContext,
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
    diff: '-old settings\n+new settings',
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
      assert.equal(JSON.parse(body.input).diff, options.diff)
      assert.match(body.instructions, /exactly one sentence per change/)
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
    { en: 'a'.repeat(3001), ru: notes.ru },
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
    generateNotes('0.1.1', { ...options, history: 'a'.repeat(600001) }, () =>
      assert.fail('No request for oversized history')
    )
  )
})

test('store material generation preserves text sources and assets and derives API listings and Markdown', async () => {
  const destination = await mkdtemp(path.join(tmpdir(), 'mega-store-materials-'))
  try {
    await prepareStoreMaterials(destination)
    const listings = await readdir(path.join(destination, 'store/listings'), {
      withFileTypes: true
    })
    assert.deepEqual(
      listings
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort(),
      ['chrome', 'firefox']
    )
    for (const shop of ['chrome', 'firefox']) {
      for (const locale of ['en', 'ru']) {
        const file = path.join('store', 'listings', shop, locale)
        const listing = await readListing(file)
        const generated = JSON.parse(await readFile(path.join(destination, `${file}.json`), 'utf8'))
        assert.deepEqual(generated, listing)
        for (const field of [
          'name',
          'summary',
          'description',
          'homepage',
          'support',
          'screenshot-captions'
        ]) {
          const source = path.join(file, `${field}.txt`)
          assert.deepEqual(await readFile(path.join(destination, source)), await readFile(source))
        }
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

test('release note retries receive fresh timeout signals', async () => {
  const signals = []
  const notes = { en: '- Fixed subscriptions.', ru: '- Исправлены подписки.' }
  const result = await generateNotes(
    '1.1.1',
    {
      apiKey: 'test-key',
      model: 'test-model',
      history: 'Fix subscriptions',
      diff: '-old settings\n+new settings',
      retryWait: async () => {}
    },
    async (_, options) => {
      signals.push(options.signal)
      assert.equal(options.signal.aborted, false)
      if (signals.length === 1) {
        return new Response('Unavailable', { status: 503 })
      }
      return new Response(
        JSON.stringify({
          status: 'completed',
          output: [
            { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(notes) }] }
          ]
        })
      )
    }
  )
  assert.deepEqual(result, notes)
  assert.equal(signals.length, 2)
  assert.notEqual(signals[0], signals[1])
})

test('baseline requires a reachable older stable release with all uploaded archives and checksums', () => {
  const release = (tag, changes = {}) => ({
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [
      ...['chromium', 'firefox', 'source', 'store-materials'].map(
        kind => `MegaProxy-${kind}-${tag}.zip`
      ),
      'SHA256SUMS'
    ].map(name => ({ name, state: 'uploaded', size: 100 })),
    ...changes
  })
  const good = release('v1.2.1')
  const tags = ['v1.2.1', 'v1.2.2', 'v1.2.3']
  for (const changes of [
    { assets: [] },
    { draft: true },
    { prerelease: true },
    { assets: release('v1.2.2').assets.slice(0, -1) },
    { assets: release('v1.2.2').assets.map(asset => ({ ...asset, size: 0 })) },
    { assets: release('v1.2.2').assets.map(asset => ({ ...asset, state: 'new' })) }
  ]) {
    assert.equal(
      selectPreviousRelease('1.2.3', tags, [
        release('v1.2.3'),
        release('v1.2.2', changes),
        release('v1.2.0'),
        good
      ]),
      'v1.2.1'
    )
  }
  assert.equal(
    selectPreviousRelease('1.11.0', ['v1.9.0', 'v1.10.0'], [release('v1.9.0'), release('v1.10.0')]),
    'v1.10.0'
  )
  assert.throws(() => selectPreviousRelease('1.2.3', tags, []), /No previous complete/)
  assert.equal(selectPreviousRelease('0.1.0', [], []), null)
})

test('release context paginates releases and sends net diff at the requested ref', () => {
  const calls = []
  const context = releaseContext('1.2.3', 'v1.2.3', undefined, (command, args) => {
    calls.push([command, args])
    if (command === 'gh') {
      assert.ok(args.includes('--paginate'))
      return JSON.stringify([
        [],
        [
          {
            tag_name: 'v1.2.1',
            draft: false,
            prerelease: false,
            assets: [
              ...['chromium', 'firefox', 'source', 'store-materials'].map(
                kind => `MegaProxy-${kind}-v1.2.1.zip`
              ),
              'SHA256SUMS'
            ].map(name => ({ name, state: 'uploaded', size: 100 }))
          }
        ]
      ])
    }
    if (args[0] === 'tag') {
      return 'v1.2.1\nv1.2.2\nv1.2.3'
    }
    if (args[0] === 'log') {
      assert.ok(args.includes('--no-merges'))
      assert.ok(args.includes('v1.2.1..v1.2.3'))
      return 'Fix stale settings'
    }
    assert.deepEqual(args.slice(0, 6), [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--unified=3',
      'v1.2.1',
      'v1.2.3'
    ])
    assert.ok(args.includes(':(exclude)releases/**'))
    assert.ok(args.includes(':(exclude)package-lock.json'))
    return '-stale\n+fresh'
  })
  assert.deepEqual(context, {
    previous: 'v1.2.1',
    head: 'v1.2.3',
    history: 'Fix stale settings',
    diff: '-stale\n+fresh'
  })
  assert.equal(calls.length, 4)
})
