import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { watchSources } from '../scripts/start.mjs'

test('watch rebuilds nested changes, serializes builds and recovers after errors', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mega-watch-'))
  await mkdir(`${dir}/nested`)
  let calls = 0
  let active = 0
  let maximum = 0
  const errors = []
  const stop = watchSources(
    async () => {
      calls++
      active++
      maximum = Math.max(maximum, active)
      try {
        if (calls === 1) {
          await writeFile(`${dir}/nested/second.js`, 'second')
          await delay(250)
          throw new Error('Build failed')
        }
      } finally {
        active--
      }
    },
    { sources: [dir], onError: error => errors.push(error.message) }
  )
  try {
    await delay(300)
    await writeFile(`${dir}/nested/first.js`, 'first')
    for (let i = 0; i < 100; i++) {
      await delay(50)
      if (calls >= 2) {
        break
      }
    }
    assert.ok(calls >= 2)
    assert.equal(maximum, 1)
    assert.deepEqual(errors, ['Build failed'])
    stop()
    const count = calls
    await writeFile(`${dir}/nested/first.js`, 'changed after stop')
    await delay(250)
    assert.equal(calls, count)
  } finally {
    stop()
    await rm(dir, { recursive: true, force: true })
  }
})
