/* global MegaErrors, chrome, MegaDiagnosticLog, MegaI18n, MegaPlatform, MEGA_TARGET */
const api = globalThis.browser || chrome
const log = new MegaDiagnosticLog()
const output = document.querySelector('#log-output')
const status = document.querySelector('#log-status')
const limit = document.querySelector('#log-limit')
let follow = true
let revision = -1
let refreshing = false

output.addEventListener('scroll', () => {
  follow = output.scrollHeight - output.scrollTop - output.clientHeight <= 4
})

function preferences(state) {
  MegaI18n.apply(state.language || 'auto')
  const platform = MegaPlatform.create(MEGA_TARGET, api)
  const theme = platform.themePreference(state.theme)
  document.documentElement.dataset.theme = theme === 'system' ? '' : theme
  output.setAttribute('aria-label', MegaI18n.t('diagnosticLog'))
}

async function refresh() {
  if (refreshing || document.hidden) {
    return
  }
  refreshing = true
  try {
    const result = await log.read(revision)
    if (result.rows) {
      const anchored = [...output.children].find(
        row => row.offsetTop + row.offsetHeight > output.scrollTop
      )
      const offset = anchored ? anchored.offsetTop - output.scrollTop : 0
      const id = anchored?.dataset.id
      const top = output.scrollTop
      const shouldFollow = follow
      output.replaceChildren(
        ...result.rows.map(row => {
          const pre = document.createElement('pre')
          pre.dataset.id = row.id
          pre.textContent = row.text
          return pre
        })
      )
      if (shouldFollow) {
        output.scrollTop = output.scrollHeight
      } else {
        const anchor = [...output.children].find(row => row.dataset.id === id)
        output.scrollTop = anchor ? anchor.offsetTop - offset : top
      }
      revision = result.meta.revision
      status.textContent = MegaI18n.t('logSize', (result.meta.bytes / 1024).toFixed(1))
    }
    if (document.activeElement !== limit) {
      limit.value = result.meta.limit / 1024 / 1024
    }
  } catch (error) {
    status.textContent = MegaErrors.format(error, 'logRead', MegaI18n.t)
  } finally {
    refreshing = false
  }
}

async function action(operation, work) {
  try {
    await work()
    await refresh()
  } catch (error) {
    status.textContent = MegaErrors.format(error, operation, MegaI18n.t)
  }
}

limit.onchange = () => action('logConfigure', () => log.configure(Number(limit.value)))
document.querySelector('#log-clear').onclick = () =>
  action('logClear', async () => {
    await log.configure(Number(limit.value), true)
    follow = true
  })
document.querySelector('#log-bottom').onclick = () => {
  follow = true
  output.scrollTop = output.scrollHeight
}
document.querySelector('#log-export').onclick = () =>
  action('logExport', async () => {
    const { rows } = await log.read(-1, Infinity)
    const url = URL.createObjectURL(
      new Blob(
        rows.map(row => row.text),
        { type: 'text/plain;charset=utf-8' }
      )
    )
    const link = document.createElement('a')
    link.href = url
    link.download = 'megaproxy-diagnostic.log'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  })
api.storage.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes.state?.newValue) {
    preferences(changes.state.newValue)
  }
})
document.addEventListener('visibilitychange', refresh)
Promise.all([MegaI18n.ready, api.storage.local.get('state')])
  .then(async ([, data]) => {
    preferences(data.state || {})
    document.body.hidden = false
    await refresh()
    setInterval(refresh, 1000)
  })
  .catch(error => {
    document.body.hidden = false
    status.textContent = MegaErrors.format(error, 'logRead', MegaI18n.t)
  })
