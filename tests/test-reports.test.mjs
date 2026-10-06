import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

test('test launcher retains named failures, later scenarios and cleanup in readable JUnit reports', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'mega-test-report-'))
  try {
    await mkdir(path.join(cwd, 'tests'))
    await writeFile(
      path.join(cwd, 'tests/scenarios.test.mjs'),
      `
      import { after, before, describe, it } from 'node:test'
      import assert from 'node:assert/strict'
      import { writeFile } from 'node:fs/promises'
      describe('Integration scenarios', () => {
        let ready = false
        before(() => { ready = true })
        after(() => writeFile('cleanup.txt', 'done'))
        it('intentional failure', () => assert.fail('visible failure detail'))
        it('later scenario still runs', () => assert.equal(ready, true))
      })
    `
    )
    let failure
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    try {
      await promisify(execFile)(process.execPath, [path.resolve('scripts/test.mjs'), 'unit'], {
        cwd,
        env
      })
    } catch (error) {
      failure = error
    }
    assert.equal(failure?.code, 1, 'Failed tests must keep the command unsuccessful')
    assert.match(failure.stdout, /later scenario still runs/)
    const xml = await readFile(path.join(cwd, 'test-results/unit.xml'), 'utf8')
    assert.match(xml, /<testsuites><testsuite name="Unit tests">/)
    assert.match(xml, /<testcase name="intentional failure"/)
    assert.match(xml, /visible failure detail/)
    assert.match(xml, /<testcase name="later scenario still runs"[^>]*\/>/)
    assert.equal(await readFile(path.join(cwd, 'cleanup.txt'), 'utf8'), 'done')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
