import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

// Firefox's temporary-addon API, shared by the development launcher and browser tests.
export async function installFirefoxAddon(port, addonPath) {
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

  async function receive(actor) {
    for (let i = 0; i < 100; i++) {
      const index = packets.findIndex(packet => packet.from === actor && !packet.type)
      if (index >= 0) {
        const [packet] = packets.splice(index, 1)
        if (packet.error) {
          throw new Error(`${packet.error}: ${packet.message}`)
        }

        return packet
      }

      await delay(100)
    }

    throw new Error(`Firefox RDP response timed out: ${actor}`)
  }

  async function request(to, type, args = {}) {
    const payload = Buffer.from(JSON.stringify({ to, type, ...args }))
    socket.write(Buffer.concat([Buffer.from(`${payload.length}:`), payload]))

    return receive(to)
  }

  try {
    await receive('root') // Initial greeting.
    const root = await request('root', 'getRoot')
    return await request(root.addonsActor, 'installTemporaryAddon', { addonPath })
  } finally {
    socket.destroy()
  }
}
