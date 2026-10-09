import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

// Firefox's temporary-addon API, shared by the development launcher and browser tests.
async function withFirefoxDebugger(port, action) {
  let socket
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      socket = await new Promise((resolve, reject) => {
        const client = net.connect(port, '127.0.0.1')
        client.once('connect', () => resolve(client))
        client.once('error', reject)
      })
      break
    } catch (error) {
      if (attempt === 49) {
        throw error
      }

      await delay(100)
    }
  }

  let buffer = Buffer.alloc(0)
  const packets = []
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])
    while (true) {
      const colon = buffer.indexOf(':')
      if (colon < 0) {
        break
      }

      const size = Number(buffer.subarray(0, colon).toString())
      if (buffer.length < colon + 1 + size) {
        break
      }

      packets.push(JSON.parse(buffer.subarray(colon + 1, colon + 1 + size).toString()))
      buffer = buffer.subarray(colon + 1 + size)
    }
  })

  async function receive(actor, type) {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const index = packets.findIndex(
        packet => packet.from === actor && (type ? packet.type === type : !packet.type)
      )
      if (index >= 0) {
        const [packet] = packets.splice(index, 1)
        if (packet.error) {
          throw new Error(`${packet.error}: ${packet.message}`)
        }

        return packet
      }

      if (socket.destroyed) {
        throw new Error('Firefox debugger connection closed')
      }
      await delay(100)
    }

    throw new Error(
      `Firefox RDP response timed out: ${actor}; closed=${socket.destroyed}; buffered=${buffer.length}; packets=${JSON.stringify(packets.map(({ from, type, error }) => ({ from, type, error })))}`
    )
  }

  async function request(to, type, args = {}) {
    const payload = Buffer.from(JSON.stringify({ to, type, ...args }))
    socket.write(Buffer.concat([Buffer.from(`${payload.length}:`), payload]))

    return receive(to)
  }

  try {
    await receive('root') // Initial greeting.
    return await action(request, receive)
  } finally {
    socket.destroy()
  }
}

export async function installFirefoxAddon(port, addonPath, { wake = false } = {}) {
  return withFirefoxDebugger(port, async request => {
    const root = await request('root', 'getRoot')
    const installed = await request(root.addonsActor, 'installTemporaryAddon', { addonPath })
    if (wake) {
      // Android may leave a temporary MV3 event page stopped until a debugger watches it.
      const { addons } = await request('root', 'listAddons')
      const addon = addons.find(addon => addon.id === installed.addon.id)
      const watcher = await request(addon.actor, 'getWatcher')
      await request(watcher.actor, 'watchTargets', { targetType: 'frame' })
      await request(addon.actor, 'reload')
    }
    return installed
  })
}

export async function quitFirefox(port) {
  return withFirefoxDebugger(port, async (request, receive) => {
    const { processDescriptor } = await request('root', 'getProcess', { id: 0 })
    const { process } = await request(processDescriptor.actor, 'getTarget')
    // Let the evaluation result reach the client before quitting closes the debugger connection.
    await request(process.consoleActor, 'evaluateJSAsync', {
      text: 'setTimeout(() => Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit), 100)'
    })
    const result = await receive(process.consoleActor, 'evaluationResult')
    if (result.exception) {
      throw new Error(`Firefox quit failed: ${result.exceptionMessage}`)
    }
  })
}
