import { setTimeout } from 'node:timers/promises'
import '../extension/errors.js'

export async function requestWithRetry(
  request,
  url,
  options,
  { secrets = [], wait = setTimeout, maxAttempts = 3, initialDelay = 1000 } = {}
) {
  for (let attempt = 0, rateLimits = 0; ; attempt++) {
    const response = await request(url, options)
    const limited = response.status === 429
    const attempts = limited ? 6 : maxAttempts
    if (
      (!limited && !(response.status >= 500 && response.status <= 599)) ||
      (limited ? rateLimits >= attempts - 1 : attempt >= attempts - 1)
    ) {
      return response
    }
    let delay = initialDelay * 2 ** attempt
    if (limited) {
      const retryAfter = response.headers?.get('Retry-After')
      const requestedDelay = retryAfter
        ? /^\d+$/u.test(retryAfter.trim())
          ? Number(retryAfter) * 1000
          : Date.parse(retryAfter) - Date.now()
        : 0
      delay = Math.min(300000, Math.max(30000 * 2 ** rateLimits++, requestedDelay || 0))
      await response.body?.cancel()
    }
    const endpoint = new URL(url)
    const error = await globalThis.MegaErrors.httpError(
      response,
      `${options?.method || 'GET'} ${endpoint.origin}${endpoint.pathname}: HTTP ${response.status}; attempt ${limited ? rateLimits : attempt + 1}/${attempts}; retrying in ${delay / 1000}s`,
      secrets
    )
    console.warn(error.message)
    await wait(delay)
  }
}
