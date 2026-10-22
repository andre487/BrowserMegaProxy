import { setTimeout } from 'node:timers/promises'
import '../extension/errors.js'

export async function requestWithRetry(
  request,
  url,
  options,
  { secrets = [], wait = setTimeout, maxAttempts = 3, initialDelay = 1000, timeoutMs } = {}
) {
  for (let attempt = 0, rateLimits = 0; ; attempt++) {
    options?.signal?.throwIfAborted()
    const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
    const response = await request(
      url,
      signal
        ? {
            ...options,
            signal: options?.signal ? AbortSignal.any([options.signal, signal]) : signal
          }
        : options
    )
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
      delay = Math.min(300000, 30000 * 2 ** rateLimits++)
      const retryAfter = response.headers?.get('Retry-After')?.trim()
      if (retryAfter) {
        const requestedDelay = /^\d+$/u.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Date.parse(retryAfter) - Date.now()
        if (Number.isFinite(requestedDelay)) {
          delay = Math.max(0, requestedDelay)
        }
      }
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
