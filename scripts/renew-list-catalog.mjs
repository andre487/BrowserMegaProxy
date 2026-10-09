import { writeFile } from 'node:fs/promises'
import '../extension/errors.js'
import '../extension/subscription-catalog.js'
import '../extension/subscriptions.js'

const catalog = await globalThis.MegaSubscriptions.refreshCatalog(undefined, undefined, true)
if (catalog.error) {
  throw new Error(catalog.error)
}
await writeFile(
  'extension/subscription-catalog.js',
  `// Generated from itdoginfo/allow-domains; renew with npm run renew-list-catalog.\nglobalThis.MegaSubscriptionCatalog = ${JSON.stringify(catalog, null, 2)}\n`
)
