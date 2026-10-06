import assert from 'node:assert/strict'
import test from 'node:test'
import { networkDiagnostics, waitForIPv6Ready } from './megaproxy-server/fixture.mjs'

test('browser startup waits for IPv6 DAD, fails on persistent tentative addresses and tolerates missing ip', async () => {
  let attempts = 0
  let waits = 0
  const command = async (file, args) => {
    assert.equal(file, 'ip')
    assert.deepEqual(args, ['-6', 'address', 'show', 'tentative'])
    return { stdout: ++attempts < 3 ? 'inet6 fe80::1 scope link tentative' : '' }
  }
  await waitForIPv6Ready(command, 'linux', async ms => {
    assert.equal(ms, 100)
    waits++
  })
  assert.equal(attempts, 3)
  assert.equal(waits, 2)
  await assert.rejects(
    waitForIPv6Ready(
      async () => ({ stdout: 'inet6 fe80::1 tentative' }),
      'linux',
      async () => {}
    ),
    /duplicate address detection did not finish/
  )
  const missing = async () => {
    throw Object.assign(new Error('not installed'), { code: 'ENOENT' })
  }
  await waitForIPv6Ready(missing, 'linux')
  await waitForIPv6Ready(() => assert.fail('ip must not run on macOS'), 'darwin')
})

test('failure diagnostics include IPv6/DAD, routing and sockets before container cleanup and tolerate missing tools', async () => {
  const calls = []
  const command = async (file, args, options) => {
    calls.push([file, ...args])
    assert.equal(options.timeout, 5000)
    if (file === 'docker' && args.includes('{{.State.Pid}}')) {
      return { stdout: '123\n', stderr: '' }
    }
    if (file === 'ss') {
      throw Object.assign(new Error('not installed'), { code: 'ENOENT' })
    }
    return { stdout: 'inet6 fe80::1 tentative dadfailed\n', stderr: '' }
  }
  const text = await networkDiagnostics(['test-container'], command, 'linux')
  assert.match(text, /tentative dadfailed/)
  assert.match(text, /Unavailable or failed: ENOENT/)
  assert.ok(calls.some(args => args.join(' ') === 'ip -6 route show table all'))
  assert.ok(calls.some(args => args.join(' ') === 'sudo -n nsenter -t 123 -n -- ss -tanp'))
  assert.ok(calls.some(args => args.includes('{{json .NetworkSettings.Networks}}')))
  calls.length = 0
  await networkDiagnostics(['test-container'], command, 'darwin')
  assert.ok(!calls.some(args => args.includes('nsenter')))
})
