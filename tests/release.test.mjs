import assert from 'node:assert/strict'
import test from 'node:test'
import { validateVersion } from '../scripts/release.mjs'

test('release versions are browser-compatible and preparation cannot reuse or downgrade a version', () => {
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
  for (const value of ['0.0.9', '0.1.0', '0.0.1']) {
    assert.throws(() => validateVersion(value, '0.1.0'), value)
  }
  assert.equal(validateVersion('0.1.1', '0.1.0'), '0.1.1')
  assert.equal(validateVersion('1.0.0', '0.99.99'), '1.0.0')
})
