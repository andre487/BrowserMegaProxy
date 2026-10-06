import { spawnSync } from 'node:child_process'
import { mkdir, readdir } from 'node:fs/promises'

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
const result = spawnSync(
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
  { stdio: 'inherit' }
)
if (result.error) {
  throw result.error
}
process.exitCode = result.status ?? 1
