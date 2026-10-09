import { setTimeout } from 'node:timers/promises'
import '../extension/errors.js'

export async function requestWithRetry(
  request,
  url,
  options,
  { secrets = [], wait = setTimeout } = {}
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await request(url, options)
    if (!(response.status >= 500 && response.status <= 599) || attempt === 2) {
      return response
    }
    const endpoint = new URL(url)
    const error = await globalThis.MegaErrors.httpError(
      response,
      `${options?.method || 'GET'} ${endpoint.origin}${endpoint.pathname}: HTTP ${response.status}; attempt ${attempt + 1}/3; retrying`,
      secrets
    )
    console.warn(error.message)
    await wait(1000 * 2 ** attempt)
  }
}
