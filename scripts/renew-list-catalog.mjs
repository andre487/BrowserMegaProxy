import { writeFile } from 'node:fs/promises'
import { requestWithRetry } from './http-request.mjs'
import '../extension/subscription-catalog.js'
import '../extension/subscriptions.js'

const catalog = await globalThis.MegaSubscriptions.refreshCatalog(
  undefined,
  // The browser downloader supplies an overall timeout; CLI retries need a fresh deadline per attempt.
  (url, options) =>
    requestWithRetry(fetch, url, { ...options, signal: undefined }, { timeoutMs: 30000 }),
  true
)
if (catalog.error) {
  throw Object.assign(new Error(catalog.error), catalog.errorDetails)
}
await writeFile(
  'extension/subscription-catalog.js',
  `// Generated from itdoginfo/allow-domains; renew with npm run renew-list-catalog.\nglobalThis.MegaSubscriptionCatalog = ${JSON.stringify(catalog, null, 2)}\n`
)
