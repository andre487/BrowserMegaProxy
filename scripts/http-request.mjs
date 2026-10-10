import { setTimeout } from 'node:timers/promises'
import '../extension/errors.js'

export async function requestWithRetry(
  request,
  url,
  options,
  { secrets = [], wait = setTimeout, maxAttempts = 3, initialDelay = 1000 } = {}
) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await request(url, options)
    if (!(response.status >= 500 && response.status <= 599) || attempt === maxAttempts - 1) {
      return response
    }
    const endpoint = new URL(url)
    const error = await globalThis.MegaErrors.httpError(
      response,
      `${options?.method || 'GET'} ${endpoint.origin}${endpoint.pathname}: HTTP ${response.status}; attempt ${attempt + 1}/${maxAttempts}; retrying`,
      secrets
    )
    console.warn(error.message)
    await wait(initialDelay * 2 ** attempt)
  }
}
