import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { finished } from 'node:stream/promises'

const suites = {
  unit: (await readdir('tests'))
    .filter(file => file.endsWith('.test.mjs'))
    .map(file => `tests/${file}`),
  'android-firefox': ['tests/android/firefox.test.mjs'],
  'android-vivaldi': ['tests/android/vivaldi.test.mjs']
}
const suite = process.argv[2]
if (!suites[suite]) {
  throw new Error(`Unknown test suite: ${suite}`)
}
await mkdir('test-results', { recursive: true })
const child = spawn(
  process.execPath,
  [
    '--test',
    '--test-reporter=spec',
    '--test-reporter=junit',
    '--test-reporter-destination=stdout',
    `--test-reporter-destination=test-results/${suite}.xml`,
    ...process.argv.slice(3),
    ...suites[suite]
  ],
  { stdio: ['inherit', 'pipe', 'pipe'] }
)
const consoleReport = createWriteStream(`test-results/${suite}.txt`)
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
child.stdout.pipe(consoleReport, { end: false })
child.stderr.pipe(consoleReport, { end: false })
const [status] = await once(child, 'close')
consoleReport.end()
await finished(consoleReport)
if (suite === 'unit') {
  // Node emits ungrouped testcases directly under testsuites; JUnit consumers
  // expect them inside a testsuite (otherwise the summary reports zero tests).
  const report = 'test-results/unit.xml'
  const xml = await readFile(report, 'utf8')
  await writeFile(
    report,
    xml
      .replace('<testsuites>', '<testsuites><testsuite name="Unit tests">')
      .replace('</testsuites>', '</testsuite></testsuites>')
  )
}
process.exitCode = status ?? 1
