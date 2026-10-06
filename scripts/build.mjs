import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'

import { createRequire } from 'node:module'
import path from 'node:path'
import Ajv from 'ajv/dist/2020.js'
import standalone from 'ajv/dist/standalone/index.js'

const require = createRequire(import.meta.url)
const schema = JSON.parse(await readFile('config-schema/megaproxy-v8.schema.json', 'utf8'))
const ajv = new Ajv({ strict: true, code: { source: true } })
const validator = standalone(ajv, ajv.compile(schema))
const lengthHelper = await readFile(require.resolve('ajv/dist/runtime/ucs2length'), 'utf8')
const validationScript = `((root) => {
  const module = { exports: {} }
  const exports = module.exports
  const helper = { exports: {} }
  ;((module, exports) => { ${lengthHelper}
 })(helper, helper.exports)
  function require (name) {
    if (name !== 'ajv/dist/runtime/ucs2length') throw new Error('Unexpected schema runtime helper')
    return helper.exports
  }
  ${validator}
  root.MegaValidate = module.exports
})(globalThis)
`

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
let commit = 'unknown'
try {
  commit = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], { encoding: 'utf8' }).trim()
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) {
    commit += '+dirty'
  }
} catch {
  // Source archives may not include Git metadata.
}

const base = {
  manifest_version: 3,
  name: '__MSG_extensionName__',
  default_locale: 'en',
  version: pkg.version,
  description: '__MSG_extensionDescription__',
  icons: {
    16: 'icons/icon16.png',
    32: 'icons/icon32.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png'
  },
  action: {
    default_popup: 'popup.html',
    default_title: '__MSG_extensionName__',
    default_icon: {
      16: 'icons/toolbar16.png',
      24: 'icons/toolbar24.png',
      32: 'icons/toolbar32.png',
      48: 'icons/toolbar48.png'
    }
  },
  options_ui: { page: 'options.html', open_in_tab: true },
  permissions: ['storage', 'scripting', 'alarms', 'contextMenus'],
  optional_permissions: ['privacy'],
  host_permissions: ['<all_urls>']
}

for (const target of ['chromium', 'firefox']) {
  const dir = `dist/${target}`
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await cp('extension', dir, { recursive: true })

  const manifest = structuredClone(base)
  if (target === 'chromium') {
    manifest.minimum_chrome_version = '120'
    manifest.permissions.push('proxy', 'webRequest', 'webRequestAuthProvider')
    manifest.background = { service_worker: 'background.js' }
  } else {
    manifest.background = {
      scripts: [
        'platform.js',
        'config-validator.js',
        'core.js',
        'subscription-catalog.js',
        'subscriptions.js',
        'background.js'
      ]
    }
    manifest.permissions.push('proxy', 'webRequest', 'webRequestAuthProvider', 'webRequestBlocking')
    manifest.browser_specific_settings = {
      gecko: {
        id: 'browser-mega-proxy@andre487',
        strict_min_version: '128.0',
        data_collection_permissions: { required: ['none'] }
      }
    }
  }

  await cp(
    path.join(path.dirname(require.resolve('ajv/package.json')), 'LICENSE'),
    `${dir}/schema-validator-LICENSE`
  )
  await writeFile(`${dir}/config-validator.js`, validationScript)
  await writeFile(
    `${dir}/build-info.js`,
    `globalThis.MegaBuild = ${JSON.stringify({ version: pkg.version, commit })}\n`
  )
  await writeFile(`${dir}/target.js`, `globalThis.MEGA_TARGET = ${JSON.stringify(target)}\n`)
  if (target !== 'chromium') {
    manifest.background.scripts.unshift('target.js')
  }

  await writeFile(`${dir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)
}
