/* global MegaErrors, chrome, MegaProxy, MegaPlatform, MEGA_TARGET, MegaSubscriptions, MegaDiagnosticLog, importScripts */
if (typeof importScripts === 'function') {
  importScripts(
    'target.js',
    'errors.js',
    'platform.js',
    'config-validator.js',
    'core.js',
    'subscription-catalog.js',
    'subscriptions.js',
    'diagnostic-log.js'
  )
}

const api = globalThis.browser || chrome
const platform = MegaPlatform.create(MEGA_TARGET, api)
const M = MegaProxy
const diagnosticLog = typeof indexedDB === 'undefined' ? null : new MegaDiagnosticLog()
let state = { ...M.defaults(), theme: platform.defaultTheme }
const attempts = new Set()
const authDialogs = new Map()
const tabUrls = new Map()
const tabOverrides = new Map()
const forcedTabs = new Set()
let connectionCheck = null
let statistics
let statisticsGeneration = 0
const networkLog = new Map()
const NETWORK_TABS = 50
const NETWORK_ROWS = 200
let knockTabs = []
let lastKnockProfile
let routingMigration = false
let knockRefresh = { pending: null, profileId: null, tabs: [] }
const ready = Promise.all([
  api.storage.local.get(['state', 'syncOptions']).then(data => {
    routingMigration =
      Boolean(data.state?.browserRouting?.assignments?.length) ||
      ['profiles', 'failover'].includes(data.state?.browserRouting?.strategy) ||
      data.state?.connectionMode === 'failover' ||
      Object.hasOwn(data.state || {}, 'failoverMode')
    syncOptions = { ...syncOptions, ...data.syncOptions }
    state = {
      ...M.defaults(),
      ...data.state,
      theme: platform.themePreference(data.state?.theme),
      ...(data.state?.connectionMode === 'failover' ? { connectionMode: 'proxy' } : {}),
      browserRouting: M.routing(data.state?.browserRouting),
      profiles: (data.state?.profiles || []).map(M.profile)
    }
    delete state.failoverMode
    delete state.failoverProfileIds
  }),
  api.storage.session
    ?.get([
      'connectionCheck',
      'knockRefresh',
      'knockTabs',
      'assignedKnockLease',
      'transientProxyLease'
    ])
    .then(data => {
      knockTabs = data.knockTabs || []
      connectionCheck = data.connectionCheck || null
      recoverTransientProxy = data.assignedKnockLease === true || data.transientProxyLease === true
      knockRefresh = platform.restoreKnockRefresh(data, knockRefresh)
    })
])
let queue = Promise.resolve()
let recoverTransientProxy = false
let startupError
let startupErrorDetails
function recordStartupError(error, operation = 'startup') {
  startupError = error.message
  startupErrorDetails = MegaErrors.details(error, operation)
  diagnosticLog?.write('startup_failed', startupErrorDetails)
}
function operationFailure(error, operation) {
  const errorDetails = MegaErrors.details(error, operation)
  diagnosticLog?.write('operation_failed', errorDetails)
  return { ok: false, error: error.message, errorDetails }
}
let downloadRouting
let syncOptions = { enabled: true, includePasswords: true }
let syncError
let syncErrorDetails
let syncRevision
const menuCatalogs = new Map()

async function apply(next) {
  next.theme = platform.themePreference(next.theme)
  await platform.apply(next)
}

async function knock() {
  const p = M.active(state)
  if (!p?.knockHost) {
    throw new Error('errorKnockMissing')
  }

  if (!platform.needsKnock(p)) {
    throw new Error('errorKnockDisabled')
  }

  if (M.bypassed(p.knockHost, p, state)) {
    throw new Error('errorKnockBypass')
  }

  const active = !M.hasCredentials(p)
  const existing = knockTabs.find(tab => tab.profileId === p.id && tab.host === p.knockHost)
  const existingTab = existing && (await api.tabs.get(existing.tabId).catch(() => null))
  const existingURL = existingTab?.pendingUrl || existingTab?.url || ''
  if (
    existingTab &&
    (existingURL === 'about:blank' ||
      (/^https?:/.test(existingURL) && M.host(new URL(existingURL).hostname) === p.knockHost))
  ) {
    if (active) {
      await api.tabs.update(existingTab.id, { active: true })
    }
    lastKnockProfile = JSON.stringify(p)
    return { ok: true, message: 'knockOpened' }
  }
  if (existing) {
    knockTabs = knockTabs.filter(tab => tab !== existing)
  }

  await platform.prepareKnock(p, knockRefresh, refreshEligible, storeKnockRefresh)
  // Completion events are queued behind this operation, so the tab ID is stored before success is handled.
  // A browser tab allows interactive proxy authentication; extension fetch does not.
  const tab = await api.tabs.create({
    url: 'about:blank',
    active
  })
  await platform.openedKnock(tab, knockRefresh, storeKnockRefresh)
  knockTabs.push({
    tabId: tab.id,
    profileId: p.id,
    host: p.knockHost,
    received: false,
    loaded: false
  })
  lastKnockProfile = JSON.stringify(p)
  await api.storage.session?.set({ knockTabs })
  try {
    await api.tabs.update(tab.id, {
      url: `https://${p.knockHost.includes(':') ? `[${p.knockHost}]` : p.knockHost}/?r=${Math.random()}`
    })
  } catch (error) {
    await updateKnockTab(tab.id, { failed: true })
    throw error
  }

  return { ok: true, message: 'knockOpened' }
}

async function updateKnockTab(
  tabId,
  { failed = false, closed = false, statusCode, url, loaded = false, loading = false } = {}
) {
  await ready
  const pending = knockTabs.find(tab => tab.tabId === tabId)
  if (!pending) {
    return
  }
  if (failed) {
    const tab = await api.tabs.get(tabId).catch(() => null)
    closed = !tab
    url = tab?.pendingUrl || tab?.url || url
  }
  if (closed || (url && /^https?:/.test(url) && M.host(new URL(url).hostname) !== pending.host)) {
    knockTabs = knockTabs.filter(tab => tab !== pending)
    await api.storage.session?.set({ knockTabs })
    return
  }
  if (loading || failed || (statusCode !== undefined && (statusCode < 200 || statusCode >= 400))) {
    // Keep failed knock tabs tracked so a successful retry can still close them.
    pending.received = false
    pending.loaded = false
    await api.storage.session?.set({ knockTabs })
    return
  }
  if (statusCode !== undefined) {
    pending.received = true
  }
  if (loaded && url && /^https?:/.test(url) && M.host(new URL(url).hostname) === pending.host) {
    pending.loaded = true
  }
  await api.storage.session?.set({ knockTabs })
  if (pending.received && pending.loaded) {
    const tab = await api.tabs.get(tabId).catch(() => null)
    knockTabs = knockTabs.filter(tab => tab !== pending)
    await api.storage.session?.set({ knockTabs })
    if (
      tab &&
      /^https?:/.test(tab.url || '') &&
      M.host(new URL(tab.url).hostname) === pending.host
    ) {
      await api.tabs.remove(tabId).catch(() => {})
    }
  }
}

async function retryKnock(details) {
  const pending = knockTabs.find(tab => tab.tabId === details.tabId)
  if (
    details.error !== 'net::ERR_NETWORK_CHANGED' ||
    !pending ||
    pending.retried ||
    M.active(state)?.id !== pending.profileId
  ) {
    return false
  }
  const tab = await api.tabs.get(details.tabId).catch(() => null)
  const url = tab?.pendingUrl || tab?.url
  if (
    !tab ||
    !/^https?:/.test(details.url || '') ||
    M.host(new URL(details.url).hostname) !== pending.host ||
    (url !== 'about:blank' &&
      url !== 'chrome-error://chromewebdata/' &&
      (!/^https?:/.test(url || '') || M.host(new URL(url).hostname) !== pending.host))
  ) {
    return false
  }
  // Proxy settings can interrupt the first navigation while Chromium applies them.
  pending.retried = true
  pending.received = false
  pending.loaded = false
  await api.storage.session?.set({ knockTabs })
  try {
    if (url === 'about:blank') {
      await api.tabs.update(details.tabId, { url: details.url })
    } else {
      await api.tabs.reload(details.tabId, { bypassCache: true })
    }
    diagnosticLog?.write('knock_retried', MegaErrors.details(new Error(details.error), 'knock'))
    return true
  } catch (error) {
    diagnosticLog?.write('knock_retry_failed', MegaErrors.details(error, 'knock'))
    return false
  }
}

function refreshEligible(tab, p = M.active(state)) {
  const url = tab.pendingUrl || tab.url
  return Boolean(
    p &&
    !tab.discarded &&
    /^https?:\/\//.test(url || '') &&
    M.host(new URL(url).hostname) !== p.knockHost &&
    M.routed(url, state) &&
    M.routeProfile(url, state)?.id === p.id
  )
}

async function storeKnockRefresh() {
  await api.storage.session?.set({ knockRefresh })
}

async function finishKnockRefresh(details, failed = false) {
  await ready
  const pending = knockRefresh.pending
  if (!pending || details.tabId !== pending.tabId || details.type !== 'main_frame') {
    return
  }

  const p = M.active(state)
  knockRefresh.pending = null
  if (
    !failed &&
    details.statusCode >= 200 &&
    details.statusCode < 400 &&
    p?.id === pending.profileId &&
    M.host(new URL(details.url).hostname) === pending.host
  ) {
    knockRefresh.profileId = p.id
    knockRefresh.tabs = pending.tabs.filter(tab => refreshEligible(tab, p))
  }

  await storeKnockRefresh()
}

async function refreshActivatedTab(tabId) {
  await ready
  const marked = knockRefresh.tabs.find(tab => tab.id === tabId)
  if (!marked) {
    return
  }

  knockRefresh.tabs = knockRefresh.tabs.filter(tab => tab.id !== tabId)
  await storeKnockRefresh() // Consume before reload to avoid loops or duplicate activation events.
  const tab = await api.tabs.get(tabId).catch(() => null)
  if (
    tab &&
    M.active(state) &&
    M.routeProfile(tab.url, state)?.id === (marked.profileId || knockRefresh.profileId) &&
    tab.url === marked.url &&
    !tab.pendingUrl &&
    tab.status !== 'loading' &&
    refreshEligible(
      tab,
      state.profiles.find(p => p.id === (marked.profileId || knockRefresh.profileId))
    )
  ) {
    await api.tabs.reload(tabId)
  }
}

async function forgetKnockTab(tabId, changedURL) {
  await ready
  let changed = false
  for (const owner of [knockRefresh, knockRefresh.pending].filter(Boolean)) {
    const tabs = owner.tabs.filter(
      tab => tab.id !== tabId || (changedURL && tab.url === changedURL)
    )
    if (tabs.length !== owner.tabs.length) {
      owner.tabs = tabs
      changed = true
    }
  }

  if (!changedURL && knockRefresh.pending?.tabId === tabId) {
    knockRefresh.pending = null
    changed = true
  }

  if (changed) {
    await storeKnockRefresh()
  }
}

async function startKnock(once = false) {
  const p = M.active(state)
  if (
    !p?.knockHost ||
    !platform.needsKnock(p) ||
    (once && lastKnockProfile === JSON.stringify(p))
  ) {
    return
  }

  await knock()
}

async function storeConnectionCheck() {
  await api.storage.session?.set({ connectionCheck })
}

function testPage(tabId, url, signal) {
  return new Promise((resolve, reject) => {
    let loaded = false
    let received = false
    const updated = (id, change, tab) => {
      if (
        id === tabId &&
        change.status === 'complete' &&
        tab.url &&
        new URL(tab.url).hostname === new URL(url).hostname
      ) {
        loaded = true
        if (received) {
          finish()
        }
      }
    }

    const abort = () => finish(new Error('errorCheckTimeout'))

    const completed = details => {
      if (details.tabId === tabId && details.type === 'main_frame') {
        if (
          new URL(details.url).hostname !== new URL(url).hostname ||
          details.statusCode < 200 ||
          details.statusCode >= 400
        ) {
          const code =
            new URL(details.url).hostname !== new URL(url).hostname
              ? 'errorCheckRedirect'
              : 'errorCheckHTTP'
          finish(Object.assign(new Error(code), { status: details.statusCode }))
        } else {
          received = true
          if (loaded) {
            finish()
          }
        }
      }
    }

    const failed = details => {
      if (details.tabId === tabId && details.type === 'main_frame') {
        finish(new Error('errorCheckNetwork', { cause: new Error(details.error) }))
      }
    }

    function finish(error) {
      api.tabs.onUpdated.removeListener(updated)
      api.webRequest.onCompleted.removeListener(completed)
      api.webRequest.onErrorOccurred.removeListener(failed)
      signal.removeEventListener('abort', abort)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }

    api.tabs.onUpdated.addListener(updated)
    api.webRequest.onCompleted.addListener(completed, { urls: ['<all_urls>'], tabId })
    api.webRequest.onErrorOccurred.addListener(failed, { urls: ['<all_urls>'], tabId })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }

    api.tabs.update(tabId, { url }).catch(finish)
  })
}

async function checkConnection() {
  const p = M.active(state)
  const mode = p ? 'proxy' : state.connectionMode === 'direct' ? 'direct' : 'system'

  const urls = [
    'https://example.com/',
    'https://ifconfig.me/ip',
    'https://api.ipify.org/',
    'https://icanhazip.com/',
    'https://ifconfig.co/country-iso',
    'https://ipapi.co/country_code/',
    'https://api.country.is/'
  ]
  if (p && urls.some(url => M.bypassed(new URL(url).hostname, p, state))) {
    throw new Error('errorCheckBypass')
  }

  const started = Date.now()
  const deadline = AbortSignal.timeout(45000)
  if (p) {
    await platform.applyTransient({
      ...state,
      routingExtraDomains: urls.map(url => new URL(url).hostname)
    })
  }
  let tab
  connectionCheck = { stage: 'https', mode, profileId: p?.id || null }
  try {
    await storeConnectionCheck()
    tab = await api.tabs.create({ url: 'about:blank', active: false })
    if (p) {
      forcedTabs.add(tab.id)
    }
    await testPage(tab.id, urls[0], AbortSignal.any([deadline, AbortSignal.timeout(10000)]))
    const latencyMs = Date.now() - started

    async function lookup(endpoints, parse) {
      for (const url of endpoints) {
        try {
          await testPage(tab.id, url, AbortSignal.any([deadline, AbortSignal.timeout(10000)]))
          const results = await api.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => document.body.innerText.slice(0, 256)
          })
          const value = parse(String(results[0]?.result || '').trim())
          if (value) {
            return value
          }
        } catch {}

        if (deadline.aborted) {
          break
        }
      }

      return ''
    }

    connectionCheck.stage = 'ip'
    await storeConnectionCheck()
    const exitIp = await lookup(urls.slice(1, 4), text => {
      try {
        const normalized = M.host(text)
        return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(text) || text.includes(':') ? normalized : ''
      } catch {
        return ''
      }
    })
    if (!exitIp) {
      throw new Error('errorCheckIP')
    }

    connectionCheck.stage = 'country'
    await storeConnectionCheck()
    const countryCode = await lookup(urls.slice(4), text => {
      if (text.startsWith('{')) {
        text = JSON.parse(text).country
      }

      return /^[a-z]{2}$/i.test(text) ? text.toUpperCase() : ''
    })
    connectionCheck = {
      stage: 'complete',
      mode,
      profileId: p?.id || null,
      exitIp,
      countryCode,
      latencyMs,
      checkedAt: Date.now()
    }
    await storeConnectionCheck()

    return { ok: true, connectionCheck }
  } catch (error) {
    connectionCheck = {
      stage: 'failed',
      mode,
      profileId: p?.id || null,
      error: MegaErrors.details(error, 'check').code,
      errorDetails: MegaErrors.details(error, 'check')
    }
    await storeConnectionCheck()
    throw error
  } finally {
    if (tab) {
      forcedTabs.delete(tab.id)
      await api.tabs.remove(tab.id).catch(() => {})
    }

    if (p) {
      await platform.applyTransient(state)
    }
  }
}

async function currentSite(tab) {
  if (!tab) {
    ;[tab] = await api.tabs.query({ active: true, currentWindow: true })
  }

  try {
    const url = new URL(tab?.url)
    if (!['http:', 'https:'].includes(url.protocol)) {
      return null
    }

    return {
      profileId: M.routed(tab.url, state, tab.url, tabOverrides.get(tab.id))
        ? M.routeProfile(tab.url, state, tab.url, tabOverrides.get(tab.id))?.id
        : null,
      tabId: tab.id,
      hostname: M.host(url.hostname),
      proxied: M.routed(tab.url, state, tab.url, tabOverrides.get(tab.id))
    }
  } catch {
    return null
  }
}

function isSubscriptionDownload(details) {
  return platform.isSubscriptionDownload(details, downloadRouting)
}

async function requestProfile(details, navigation = false) {
  const tabUrl = await platform.tabUrl(details, state, tabUrls, navigation)
  const routedState = isSubscriptionDownload(details)
    ? { ...state, downloadRouting }
    : forcedTabs.has(details.tabId)
      ? { ...state, browserRouting: { ...state.browserRouting, enabled: false } }
      : state

  return M.routed(details.url, routedState, tabUrl, tabOverrides.get(details.tabId))
    ? M.routeProfile(details.url, routedState, tabUrl, tabOverrides.get(details.tabId))
    : undefined
}

function neededSubscriptions() {
  const config = state.browserRouting
  if (!M.active(state) || !config.enabled || (config.strategy && config.strategy !== 'lists')) {
    return false
  }
  return Boolean(
    config.subscriptions[config.mode === 'tabs' ? 'siteSources' : 'domainSources'].length
  )
}

async function updateSubscriptions(forceCatalog = false, catalogOnly = false) {
  const original = state.browserRouting
  const config = {
    ...original,
    subscriptions: {
      ...original.subscriptions,
      domainSources:
        !catalogOnly && original.mode === 'domains' ? original.subscriptions.domainSources : [],
      siteSources:
        !catalogOnly && original.mode === 'tabs' ? original.subscriptions.siteSources : []
    }
  }
  const settings = config.subscriptions

  if (settings.throughProxy && !M.active(state)) {
    state = {
      ...state,
      subscriptionCache: {
        ...state.subscriptionCache,
        attemptedAt: Date.now(),
        error: 'errorListProxyInactive'
      }
    }
    await api.storage.local.set({ state })
    throw new Error('errorListProxyInactive')
  }

  downloadRouting = {
    hosts: ['api.github.com', 'raw.githubusercontent.com', 'tranco-list.eu'],
    throughProxy: settings.throughProxy
  }
  try {
    await platform.applyTransient({ ...state, downloadRouting })
    const subscriptionCatalog = await MegaSubscriptions.refreshCatalog(
      state.subscriptionCatalog,
      undefined,
      forceCatalog
    )
    state = { ...state, subscriptionCatalog }
    if (catalogOnly) {
      await api.storage.local.set({ state })
      return { ok: true, state }
    }
    const cache = await MegaSubscriptions.update(
      config,
      state.subscriptionCache,
      undefined,
      MegaSubscriptions.catalog(subscriptionCatalog)
    )
    const next = {
      ...state,
      subscriptionCache: {
        ...cache,
        sourceKey: MegaSubscriptions.sourceKey(original.subscriptions),
        mode: original.mode
      }
    }
    await platform.applyTransient(next)
    await api.storage.local.set({ state: next })
    state = next
  } catch (error) {
    const code = /^errorList/.test(error.message) ? error.message : 'errorListDownload'
    state = {
      ...state,
      subscriptionCache: {
        ...state.subscriptionCache,
        attemptedAt: Date.now(),
        error: code,
        errorDetails: MegaErrors.details(new Error(code, { cause: error }), 'updateSubscriptions')
      }
    }
    await api.storage.local.set({ state })
    throw new Error(code, { cause: error })
  } finally {
    downloadRouting = undefined
    await platform.applyTransient(state)
  }

  return { ok: true, state }
}

async function scheduleSubscriptions() {
  const settings = state.browserRouting.subscriptions
  if (!api.alarms) {
    return
  }

  if (settings.autoUpdate && neededSubscriptions()) {
    // Check hourly; failed updates retry after an hour, successful snapshots last a day.
    if (!api.alarms.get || !(await api.alarms.get('subscriptions'))) {
      await api.alarms.create('subscriptions', { delayInMinutes: 60, periodInMinutes: 60 })
    }
  } else {
    await api.alarms.clear('subscriptions')
  }
}

async function refreshSubscriptions(force = false, panel = false) {
  const settings = state.browserRouting.subscriptions
  const needed = neededSubscriptions()
  if (!panel && (!needed || !settings.autoUpdate)) {
    return
  }
  const cache = state.subscriptionCache
  const changed =
    cache?.sourceKey !== MegaSubscriptions.sourceKey(settings) ||
    cache?.mode !== state.browserRouting.mode
  const due = Date.now() - (cache?.updatedAt || 0) >= 24 * 60 * 60 * 1000
  const retry = Date.now() - (cache?.attemptedAt || 0) >= 60 * 60 * 1000
  const catalog = state.subscriptionCatalog
  const catalogDue =
    Date.now() - (catalog?.updatedAt || 0) >= 24 * 60 * 60 * 1000 &&
    (panel || Date.now() - (catalog?.attemptedAt || 0) >= 60 * 60 * 1000)
  const contentDue = needed && (force || changed || (due && (panel || retry)))
  if (contentDue || catalogDue) {
    await updateSubscriptions(false, !contentDue)
  }
}

async function handle(message) {
  await ready
  if (['authGet', 'authSubmit', 'authCancel'].includes(message.command)) {
    return authCommand(message)
  }
  if (message.command === 'telemetry') {
    return { ok: true, ...(state.statisticsEnabled ? { statistics: { ...statistics } } : {}) }
  }

  if (message.command === 'get') {
    return {
      ok: true,
      ...(state.statisticsEnabled === true ? { statistics: { ...statistics } } : {}),
      state,
      connectionCheck,
      target: platform.id,
      syncOptions,
      syncError,
      syncErrorDetails,
      warning: startupError,
      warningDetails: startupErrorDetails
    }
  }

  if (message.command === 'network') {
    const site = await currentSite()
    const tabId = Number.isInteger(message.tabId) ? message.tabId : site?.tabId
    return {
      ok: true,
      tabId,
      entries: state.statisticsEnabled
        ? (networkLog.get(tabId) || []).map(entry => ({ ...entry }))
        : []
    }
  }

  if (message.command === 'clearNetwork') {
    networkLog.clear()
    return { ok: true }
  }

  if (message.command === 'addFailedDomains') {
    const strategy = M.routingStrategy(state.browserRouting)
    if (!['manual', 'tabs'].includes(strategy)) {
      throw new Error('errorProfileFields', { cause: new Error('errorFailedDomainMode') })
    }
    const rows = networkLog.get(message.tabId) || []
    if (
      !state.statisticsEnabled ||
      !Array.isArray(message.domains) ||
      !message.domains.length ||
      message.domains.length > NETWORK_ROWS ||
      message.domains.some(domain => !rows.some(row => row.failed && row.domain === domain))
    ) {
      throw new Error('errorProfileFields', { cause: new Error('errorFailedDomainSelection') })
    }

    const domains = [...new Set(message.domains.map(M.host))]
    const key = strategy === 'tabs' ? 'sites' : 'domains'
    return handle({
      command: 'routing',
      routing: {
        ...state.browserRouting,
        [key]: [
          ...new Set([...state.browserRouting[key], ...domains.map(domain => `**.${domain}`)])
        ]
      }
    })
  }

  if (message.command === 'sync') {
    if (
      !api.storage.sync ||
      typeof message.enabled !== 'boolean' ||
      typeof message.includePasswords !== 'boolean'
    ) {
      throw new Error('errorSync')
    }

    const wasEnabled = syncOptions.enabled
    const previous = syncOptions
    syncOptions = { enabled: message.enabled, includePasswords: message.includePasswords }
    try {
      await api.storage.local.set({ syncOptions })
    } catch (error) {
      syncOptions = previous
      throw error
    }

    if (syncOptions.enabled) {
      if (!wasEnabled) {
        await receiveSync()
      }

      await publishSync()
    }

    return { ok: true, state, syncOptions, syncError }
  }

  if (message.command === 'fetchConfig') {
    return { ok: true, data: await fetchConfig(message.url) }
  }

  if (message.command === 'testRule') {
    let url, tabUrl
    try {
      url = new URL(message.url)
      tabUrl = new URL(message.tabUrl || message.url)
    } catch {
      throw new Error('errorRuleURL')
    }

    if (![url, tabUrl].every(u => ['http:', 'https:'].includes(u.protocol))) {
      throw new Error('errorRuleURL')
    }

    const proxied = M.routed(url.href, state, tabUrl.href)
    const p = proxied && M.routeProfile(url.href, state, tabUrl.href)
    return { ok: true, proxied, profile: p ? { name: p.name || p.host, id: p.id } : null }
  }

  if (message.command === 'updateSubscriptions') {
    return updateSubscriptions(true, !neededSubscriptions())
  }

  if (message.command === 'routingOpened') {
    await refreshSubscriptions(false, true)
    return { ok: true, state }
  }

  if (message.command === 'currentSite') {
    return { ok: true, currentSite: await currentSite() }
  }

  if (message.command === 'toggleTab') {
    if (
      !platform.supportsTabRouting ||
      !state.browserRouting.enabled ||
      state.browserRouting.mode !== 'tabs'
    ) {
      throw new Error('errorSplitUnsupported')
    }

    const site = await currentSite(message.tab)
    if (!site || !M.active(state)) {
      throw new Error('errorCurrentSite')
    }

    tabOverrides.set(site.tabId, !site.proxied)
    await api.tabs.reload(site.tabId)
    return { ok: true, currentSite: await currentSite() }
  }

  if (message.command === 'knock') {
    diagnosticLog?.write('knock_started')
    return knock()
  }

  if (message.command === 'check') {
    diagnosticLog?.write('connection_check_started')
    const result = await checkConnection()
    diagnosticLog?.write('connection_check_finished', { code: result.connectionCheck?.error })
    return result
  }

  if (message.command === 'export') {
    return { ok: true, config: M.exportConfig(state, message.includePasswords === true) }
  }

  if (message.command === 'previewImport') {
    const result = M.importProfiles(message.data)
    return {
      ok: true,
      added: result.profiles.filter(p => !state.profiles.some(old => old.id === p.id)).length,
      updated: result.profiles.filter(p => state.profiles.some(old => old.id === p.id)).length,
      skipped: result.skipped,
      unknownFields: result.unknownFields || false,
      unsupportedSplitProxy: result.unsupportedSplitProxy || false,
      unsupportedWebRTC: result.unsupportedWebRTC || false,
      absent: result.config
        ? state.profiles
            .filter(p => !result.profiles.some(next => next.id === p.id))
            .map(p => ({ id: p.id, name: p.name || p.host }))
        : []
    }
  }

  let next = structuredClone(state)
  if (message.command === 'save') {
    const old = next.profiles.find(p => p.id === message.profile.id)
    const p = M.profile({ ...old, ...message.profile })
    const index = next.profiles.findIndex(item => item.id === p.id)
    if (index < 0) {
      if (next.profiles.length >= 1000) {
        throw new Error('errorImport')
      }

      next.profiles.push(p)
    } else {
      next.profiles[index] = p
    }
  } else if (message.command === 'clone') {
    const p = next.profiles.find(p => p.id === message.id)
    if (!p || next.profiles.length >= 1000) {
      throw new Error('errorProfileMissing')
    }

    next.profiles.push({
      ...structuredClone(p),
      id: crypto.randomUUID(),
      name: String(message.name || p.name).slice(0, 256)
    })
  } else if (message.command === 'move') {
    const index = next.profiles.findIndex(p => p.id === message.id)
    const to = message.position ?? index + message.direction
    if (
      index < 0 ||
      !Number.isInteger(to) ||
      (message.position === undefined && ![-1, 1].includes(message.direction)) ||
      to < 0 ||
      to >= next.profiles.length
    ) {
      throw new Error('errorProfileMissing')
    }

    next.profiles.splice(to, 0, next.profiles.splice(index, 1)[0])
  } else if (message.command === 'activate') {
    if (message.id !== null && !next.profiles.some(p => p.id === message.id)) {
      throw new Error('errorProfileMissing')
    }

    next.activeId = message.id
    next.connectionMode = message.id === null ? 'system' : 'proxy'
    const p = M.active(next)
    if (p?.knockHost && platform.needsKnock(p)) {
      if (M.bypassed(p.knockHost, p, next)) {
        throw new Error('errorKnockBypass')
      }
    }
  } else if (message.command === 'connectionMode') {
    if (!['proxy', 'direct', 'system'].includes(message.mode)) {
      throw new Error('errorProfileFields', { cause: new Error('errorConnectionMode') })
    }

    next.connectionMode = message.mode
    if (message.mode === 'proxy') {
      next.activeId ||= next.profiles[0]?.id || null
    }
  } else if (message.command === 'delete') {
    next.profiles = next.profiles.filter(p => p.id !== message.id)
    if (next.activeId === message.id) {
      next.activeId = null
    }
  } else if (message.command === 'import') {
    const result = M.importProfiles(message.data)
    next = M.mergeImport(next, result, message.removeIds || [])
    message.skipped = result.skipped
    message.unsupportedSplitProxy = result.unsupportedSplitProxy
    message.unsupportedWebRTC = result.unsupportedWebRTC
  } else if (message.command === 'routing') {
    next.browserRouting = M.routing(message.routing)

    platform.validateRouting(next.browserRouting)
  } else if (message.command === 'addCurrentSite') {
    const site = await currentSite(message.tab)
    if (!site) {
      throw new Error('errorCurrentSite')
    }

    const key = next.browserRouting.mode === 'tabs' ? 'sites' : 'domains'
    next.browserRouting = M.routing({
      ...next.browserRouting,
      enabled: true,
      strategy: key === 'sites' ? 'tabs' : 'manual',
      [key]: [...next.browserRouting[key], `**.${site.hostname}`]
    })
    message.reloadTabId = site.tabId
  } else if (message.command === 'excludeCurrentSite') {
    const site = await currentSite(message.tab)
    const p = site && M.routeProfile(`https://${site.hostname}/`, next, `https://${site.hostname}/`)
    if (!p) {
      throw new Error('errorCurrentSite')
    }

    p.bypass = [...new Set([...p.bypass, site.hostname])]
    message.reloadTabId = site.tabId
  } else if (message.command === 'bypassLocalNetworks') {
    if (typeof message.enabled !== 'boolean') {
      throw new Error('errorProfileFields', { cause: new Error('errorBooleanSetting') })
    }

    next.bypassLocalNetworks = message.enabled
  } else if (message.command === 'statistics') {
    if (typeof message.enabled !== 'boolean') {
      throw new Error('errorProfileFields', { cause: new Error('errorBooleanSetting') })
    }

    next.statisticsEnabled = message.enabled
  } else if (message.command === 'webRTC') {
    next.webRTC = M.webRTC(message.value)
  } else if (message.command === 'theme') {
    if (!['system', 'light', 'dark'].includes(message.theme)) {
      throw new Error('errorTheme')
    }

    next.theme = message.theme
  } else if (message.command === 'language') {
    if (!['auto', 'ru', 'en'].includes(message.language)) {
      throw new Error('errorLanguage')
    }

    next.language = message.language
  } else {
    throw new Error('errorCommand')
  }

  // Apply native settings and persist the same state; failures restore the previous state.
  const old = state
  next.theme = platform.themePreference(next.theme)
  state = next // Publish credentials before the first 407 can arrive.
  try {
    if (
      message.command === 'activate' ||
      old.connectionMode !== next.connectionMode ||
      (M.active(next) && JSON.stringify(old.profiles) !== JSON.stringify(next.profiles)) ||
      old.bypassLocalNetworks !== next.bypassLocalNetworks ||
      JSON.stringify(old.browserRouting) !== JSON.stringify(next.browserRouting) ||
      JSON.stringify(M.active(old)) !== JSON.stringify(M.active(next))
    ) {
      await apply(next)
    }

    if (old.webRTC !== next.webRTC) {
      await applyWebRTC(next.webRTC)
    }

    await api.storage.local.set({ state: next })
    startupError = undefined
    if (['save', 'activate', 'delete', 'import', 'connectionMode'].includes(message.command)) {
      for (const [id, dialog] of authDialogs) {
        const profile = state.profiles.find(profile => profile.id === id)
        if (dialog.phase === 'cancelled' || !sameAuthProfile(profile, dialog.profile)) {
          cancelAuth(dialog)
          authDialogs.delete(id)
        }
      }
    }
  } catch (error) {
    state = old
    diagnosticLog?.write('settings_failed', MegaErrors.details(error, message.command))
    await apply(old).catch(() => {})
    if (old.webRTC !== next.webRTC) {
      await applyWebRTC(old.webRTC).catch(() => {})
    }

    throw error
  }

  // Update in-memory state only after the settings have been persisted.
  if (old.statisticsEnabled !== next.statisticsEnabled) {
    configureStatistics()
  }

  if (JSON.stringify(old.browserRouting) !== JSON.stringify(next.browserRouting)) {
    tabOverrides.clear()
  }

  if (message.reloadTabId !== undefined) {
    tabOverrides.delete(message.reloadTabId)
    await api.tabs.reload(message.reloadTabId).catch(() => {})
  }

  if (
    JSON.stringify(old.browserRouting) !== JSON.stringify(next.browserRouting) ||
    old.connectionMode !== next.connectionMode ||
    old.activeId !== next.activeId
  ) {
    await scheduleSubscriptions()
    const settingsChanged =
      JSON.stringify(old.browserRouting.subscriptions) !==
      JSON.stringify(next.browserRouting.subscriptions)
    queue = queue.then(() => refreshSubscriptions(settingsChanged)).catch(() => {})
  }

  // Authentication must restart when the active proxy or its credentials change.
  const restarted = ['id', 'host', 'port', 'type', 'username', 'password', 'knockHost'].some(
    key => M.active(old)?.[key] !== M.active(next)?.[key]
  )
  if (message.command === 'activate' || message.command === 'connectionMode' || restarted) {
    connectionCheck = null
    await storeConnectionCheck()
    await startKnock().catch(error => {
      recordStartupError(error)
    })
  }

  await publishSync()
  diagnosticLog?.write('settings_changed', {
    mode: state.connectionMode,
    profile: state.profiles.findIndex(p => p.id === state.activeId)
  })

  await rebuildMenus()
  await refreshBadges()

  return {
    ok: true,
    state,
    syncOptions,
    syncError,
    syncErrorDetails,
    connectionCheck,
    target: platform.id,
    skipped: message.skipped,
    unsupportedSplitProxy: message.unsupportedSplitProxy,
    warningDetails:
      message.unsupportedSplitProxy || message.unsupportedWebRTC ? undefined : startupErrorDetails,
    warning: message.unsupportedSplitProxy
      ? 'splitUnsupportedWarning'
      : message.unsupportedWebRTC
        ? 'errorWebRTCUnsupported'
        : startupError
  }
}

api.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    sender.id !== api.runtime.id ||
    (sender.tab && !sender.url?.startsWith(api.runtime.getURL('')))
  ) {
    return false
  }

  if (
    ['authGet', 'authSubmit', 'authCancel'].includes(message.command) &&
    sender.url !== api.runtime.getURL('auth.html') + '?id=' + message.token
  ) {
    return false
  }
  if (
    ['get', 'currentSite', 'network', 'telemetry', 'authGet', 'authSubmit', 'authCancel'].includes(
      message.command
    )
  ) {
    handle(message)
      .then(respond)
      .catch(error => respond(operationFailure(error, message.command)))
  } else {
    queue = queue
      .then(() => handle(message))
      .catch(error => {
        return operationFailure(error, message.command)
      })
    queue.then(respond)
  }

  return true
})

platform.registerRouting({
  ready,
  state: () => state,
  requestProfile,
  directRequest: details => isSubscriptionDownload(details) && !downloadRouting.throughProxy
})

api.tabs.onRemoved?.addListener(tabId => {
  queue = queue.then(() => updateKnockTab(tabId, { closed: true })).catch(() => {})
  for (const dialog of authDialogs.values()) {
    if (dialog.dialogTabId === tabId) {
      cancelAuth(dialog)
      dialog.windowId = undefined
      dialog.dialogTabId = undefined
    } else if (
      dialog.tabId === tabId &&
      ['waiting', 'rejected', 'checking'].includes(dialog.phase)
    ) {
      cancelAuth(dialog)
    }
  }
  badgeVersions.delete(tabId)
  networkLog.delete(tabId)
  tabUrls.delete(tabId)
  tabOverrides.delete(tabId)
  forcedTabs.delete(tabId)
})
api.tabs.onUpdated?.addListener((tabId, change, tab) => {
  if (change.status === 'complete') {
    queue = queue.then(() => updateKnockTab(tabId, { loaded: true, url: tab?.url })).catch(() => {})
    updateBadge(tabId).catch(() => {})
  }

  if (change.url) {
    networkLog.delete(tabId)
    tabUrls.set(tabId, change.url)
    updateBadge(tabId, change.url).catch(() => {})
  }
})

api.tabs.onActivated?.addListener(({ tabId }) => {
  updateBadge(tabId).catch(() => {})
})

platform.registerKnockRefresh({
  enqueue: operation => {
    queue = queue.then(operation).catch(() => {})
  },
  forget: forgetKnockTab,
  activate: refreshActivatedTab,
  finish: finishKnockRefresh
})

function sameAuthProfile(profile, original) {
  return (
    profile &&
    ['host', 'port', 'type', 'username', 'password'].every(key => profile[key] === original[key])
  )
}

function authView(dialog) {
  return {
    ok: true,
    auth: {
      phase: dialog.phase,
      name: dialog.profile.name || dialog.profile.host,
      host: dialog.profile.host,
      port: dialog.profile.port,
      username: dialog.profile.username,
      errorDetails: dialog.errorDetails,
      theme: state.theme,
      language: state.language
    }
  }
}

function cancelAuth(dialog) {
  const pending = !['saved', 'cancelled'].includes(dialog.phase)
  dialog.phase = 'cancelled'
  dialog.credentials = undefined
  const respond = dialog.respond
  dialog.respond = undefined
  respond?.({ cancel: true })
  if (pending) {
    diagnosticLog?.write('proxy_auth_cancelled', { operation: 'authentication' })
  }
}

async function showAuth(details, respond, profile) {
  let dialog = authDialogs.get(profile.id)
  if (dialog?.phase === 'cancelled') {
    if (details.type !== 'main_frame') {
      respond({ cancel: true })
      return
    }
    authDialogs.delete(profile.id)
    dialog = undefined
  }
  if (
    dialog?.respond ||
    (dialog?.phase === 'checking' && dialog.requestId !== details.requestId) ||
    dialog?.phase === 'saving'
  ) {
    respond({ cancel: true })
    return
  }
  if (!dialog) {
    dialog = { token: crypto.randomUUID(), profile: { ...profile } }
    authDialogs.set(profile.id, dialog)
  }
  dialog.phase = dialog.phase === 'checking' ? 'rejected' : 'waiting'
  dialog.errorDetails =
    dialog.phase === 'rejected'
      ? MegaErrors.details(new Error('errorAuthRejected'), 'authentication')
      : undefined
  dialog.credentials = undefined
  dialog.requestId = details.requestId
  dialog.tabId = details.tabId
  dialog.respond = respond
  if (dialog.windowId !== undefined || dialog.dialogTabId !== undefined) {
    await api.tabs.update(dialog.dialogTabId, { active: true })
    if (dialog.windowId !== undefined) {
      await api.windows.update(dialog.windowId, { focused: true })
    }
    return
  }
  const url = api.runtime.getURL('auth.html') + '?id=' + dialog.token
  const mobile = (await api.runtime.getPlatformInfo?.())?.os === 'android'
  if (!mobile && api.windows?.create) {
    const window = await api.windows.create({
      url,
      type: 'popup',
      focused: true,
      width: 440,
      height: 460
    })
    dialog.windowId = window.id
    dialog.dialogTabId = window.tabs?.[0]?.id
  } else {
    const tab = await api.tabs.create({ url, active: true })
    dialog.dialogTabId = tab.id
  }
  diagnosticLog?.write('proxy_auth_dialog_opened', { operation: 'authentication' })
}

async function authCommand(message) {
  const dialog = [...authDialogs.values()].find(dialog => dialog.token === message.token)
  if (!dialog) {
    throw new Error('errorAuthExpired')
  }
  if (message.command === 'authGet') {
    return authView(dialog)
  }
  if (message.command === 'authCancel') {
    cancelAuth(dialog)
    return { ok: true }
  }
  if (!dialog.respond || !['waiting', 'rejected'].includes(dialog.phase)) {
    throw new Error('errorAuthExpired')
  }
  if (
    !sameAuthProfile(
      state.profiles.find(profile => profile.id === dialog.profile.id),
      dialog.profile
    )
  ) {
    throw new Error('errorAuthProfileChanged')
  }
  if (typeof message.username !== 'string' || typeof message.password !== 'string') {
    throw new Error('errorAuthCredentials')
  }
  const profile = M.profile({
    ...dialog.profile,
    username: message.username,
    password: message.password
  })
  if (!M.hasCredentials(profile)) {
    throw new Error('errorAuthCredentials')
  }
  dialog.credentials = { username: profile.username, password: profile.password }
  dialog.phase = 'checking'
  dialog.errorDetails = undefined
  const respond = dialog.respond
  dialog.respond = undefined
  respond({ authCredentials: dialog.credentials })
  diagnosticLog?.write('proxy_auth_submitted', { operation: 'authentication' })
  return authView(dialog)
}

function finishAuth(details, failed = false) {
  const dialog = [...authDialogs.values()].find(dialog => dialog.requestId === details.requestId)
  if (!dialog || !['checking', 'waiting', 'rejected'].includes(dialog.phase)) {
    return
  }
  if (
    failed ||
    !Number.isInteger(details.statusCode) ||
    details.statusCode < 200 ||
    details.statusCode > 599 ||
    details.statusCode === 407 ||
    !dialog.credentials
  ) {
    dialog.respond = undefined
    dialog.credentials = undefined
    dialog.phase = 'failed'
    dialog.errorDetails = MegaErrors.details(
      new Error('errorAuthUnconfirmed', {
        cause: details.error
          ? new Error(details.error)
          : details.statusCode === 407
            ? new Error('errorAuthRejected')
            : undefined
      }),
      'authentication'
    )
    diagnosticLog?.write('proxy_auth_unconfirmed', dialog.errorDetails)
    return
  }
  dialog.phase = 'saving'
  const credentials = dialog.credentials
  queue = queue
    .then(async () => {
      if (dialog.phase !== 'saving') {
        return
      }
      // Save only after the challenged request reaches an HTTP response; no speculative credential writes.
      const current = state.profiles.find(profile => profile.id === dialog.profile.id)
      if (!sameAuthProfile(current, dialog.profile)) {
        throw new Error('errorAuthProfileChanged')
      }
      const profile = M.profile({ ...current, ...credentials })
      const next = {
        ...state,
        profiles: state.profiles.map(p => (p.id === profile.id ? profile : p))
      }
      await api.storage.local.set({ state: next })
      state = next
      dialog.profile = { ...profile }
      dialog.credentials = undefined
      dialog.phase = 'saved'
      await publishSync()
      diagnosticLog?.write('proxy_auth_saved', { operation: 'authentication' })
    })
    .catch(error => {
      dialog.credentials = undefined
      dialog.phase = 'failed'
      dialog.errorDetails = MegaErrors.details(error, 'save')
      diagnosticLog?.write('proxy_auth_save_failed', dialog.errorDetails)
    })
}

api.windows?.onRemoved?.addListener(windowId => {
  for (const dialog of authDialogs.values()) {
    if (dialog.windowId === windowId) {
      cancelAuth(dialog)
      dialog.windowId = undefined
      dialog.dialogTabId = undefined
    }
  }
})

api.webRequest.onAuthRequired.addListener(
  (details, respond) => {
    if (details.isProxy) {
      diagnosticLog?.write('proxy_auth_required', { type: details.type })
    }
    ready
      .then(async () => {
        const profile = M.authProfile(details, state)
        const response = M.auth(details, state, attempts)
        const dialog = profile && authDialogs.get(profile.id)
        if (
          profile &&
          M.hasCredentials(profile) &&
          (response.cancel || (dialog && dialog.phase !== 'cancelled' && dialog.phase !== 'saved'))
        ) {
          await showAuth(details, respond, profile)
          return
        }
        if (details.isProxy) {
          diagnosticLog?.write(
            response.authCredentials ? 'proxy_auth_supplied' : 'proxy_auth_skipped'
          )
        }
        respond(response)
      })
      .catch(error => {
        const dialog = [...authDialogs.values()].find(
          dialog => dialog.requestId === details.requestId
        )
        if (dialog) {
          cancelAuth(dialog)
        } else {
          respond({ cancel: true })
        }
        diagnosticLog?.write('proxy_auth_failed', MegaErrors.details(error, 'authentication'))
      })
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking']
)

// Counters stay in memory; no storage writes or UI updates for each request.
async function countRequest(details, failed) {
  const generation = statisticsGeneration
  if (state.statisticsEnabled !== true) {
    return
  }

  let rows
  if (details.tabId >= 0 && /^https?:\/\//.test(details.url)) {
    rows = networkLog.get(details.tabId)
    if (!rows) {
      if (networkLog.size >= NETWORK_TABS) {
        networkLog.delete(networkLog.keys().next().value)
      }

      rows = []
      networkLog.set(details.tabId, rows)
    }
  }

  const p = await requestProfile(details)
  const proxied = Boolean(p) && (!details.proxyInfo || details.proxyInfo.type !== 'direct')
  if (generation !== statisticsGeneration || state.statisticsEnabled !== true) {
    return
  }

  if (proxied) {
    statistics[failed ? 'failed' : 'completed']++
  }

  if (rows && networkLog.get(details.tabId) === rows) {
    if (rows.length >= NETWORK_ROWS) {
      rows.shift()
    }
    // Keep only origin: query strings and paths may contain private tokens. No persistence per request.
    rows.push({
      domain: new URL(details.url).hostname,
      type: details.type,
      failed,
      error: failed ? String(details.error || `HTTP ${details.statusCode}`).slice(0, 128) : '',
      status: details.statusCode,
      proxied,
      profileId: p?.id || null,
      time: Date.now()
    })
  }
}

const countCompleted = details => {
  countRequest(details, details.statusCode >= 400).catch(() => {})
}

const countFailed = details => {
  countRequest(details, true).catch(() => {})
}

function configureStatistics() {
  statisticsGeneration++
  if (statistics) {
    api.webRequest.onCompleted.removeListener(countCompleted)
    api.webRequest.onErrorOccurred.removeListener(countFailed)
  }

  statistics = undefined
  networkLog.clear()
  if (state.statisticsEnabled === true) {
    statistics = { completed: 0, failed: 0, startedAt: Date.now() }
    api.webRequest.onCompleted.addListener(countCompleted, { urls: ['<all_urls>'] })
    api.webRequest.onErrorOccurred.addListener(countFailed, { urls: ['<all_urls>'] })
  }
}

ready.then(configureStatistics)

// tabs.onUpdated can report "loading" after a fast response has already completed.
api.webRequest.onBeforeRequest?.addListener(
  details => {
    queue = queue
      .then(() => updateKnockTab(details.tabId, { loading: true, url: details.url }))
      .catch(() => {})
  },
  { urls: ['<all_urls>'], types: ['main_frame'] }
)
api.webRequest.onCompleted.addListener(
  details => {
    finishAuth(details)
    attempts.delete(details.requestId)
    if (details.type === 'main_frame') {
      queue = queue.then(() => updateKnockTab(details.tabId, details)).catch(() => {})
    }
  },
  { urls: ['<all_urls>'] }
)
api.webRequest.onErrorOccurred.addListener(
  details => {
    finishAuth(details, true)
    attempts.delete(details.requestId)
    if (details.tabId >= 0 && ['main_frame', 'xmlhttprequest'].includes(details.type)) {
      diagnosticLog?.write('request_failed', {
        type: details.type,
        ...MegaErrors.details(new Error(details.error), 'request')
      })
    }
    if (details.type === 'main_frame') {
      queue = queue
        .then(async () => {
          if (await retryKnock(details)) {
            return
          }
          await finishKnockRefresh(details, true)
          await updateKnockTab(details.tabId, { failed: true })
        })
        .catch(() => {})
    }
  },
  { urls: ['<all_urls>'] }
)

for (const event of ['onInstalled', 'onStartup']) {
  api.runtime[event]?.addListener(() => {
    queue = queue
      .then(async () => {
        await ready
        await scheduleSubscriptions()
        await apply(state)
        await refreshBadges()
        if (M.active(state)) {
          connectionCheck = null
          await storeConnectionCheck()
          await startKnock(true)
        }

        const subscriptions = state.browserRouting.subscriptions
        // Catalog-only refreshes run on the alarm or explicit request, so installation
        // does not block edits or temporarily override System while fetching GitHub.
        if (subscriptions.domainSources.length || subscriptions.siteSources.length) {
          await refreshSubscriptions()
        }
      })
      .catch(error => {
        recordStartupError(error)
      })
  })
}

api.alarms?.onAlarm.addListener(alarm => {
  if (alarm.name === 'subscriptions') {
    queue = queue
      .then(async () => {
        await ready
        await refreshSubscriptions()
      })
      .catch(() => {})
  }
})

ready.then(scheduleSubscriptions).catch(() => {})

async function applyWebRTC(value) {
  M.webRTC(value)
  if (!platform.supportsWebRTC(value)) {
    throw new Error('errorWebRTCUnsupported')
  }

  if (
    api.permissions?.contains &&
    !(await api.permissions.contains({ permissions: ['privacy'] }))
  ) {
    if (value === 'browser') {
      return
    }

    throw new Error('errorPrivacyPermission')
  }

  const network = api.privacy?.network
  if (!network) {
    if (value === 'browser') {
      return
    }

    throw new Error('errorPrivacyPermission')
  }

  const settings = [
    [network.webRTCIPHandlingPolicy, value === 'disabled' ? 'disable_non_proxied_udp' : value],
    [network.peerConnectionEnabled, value !== 'disabled']
  ]
  const snapshots = []
  for (const [setting] of settings) {
    if (!setting) {
      continue
    }

    const current = await setting.get({})
    snapshots.push([setting, current])
    if (
      value !== 'browser' &&
      !['controlled_by_this_extension', 'controllable_by_this_extension'].includes(
        current.levelOfControl
      )
    ) {
      throw new Error('errorPrivacyControl')
    }
  }

  try {
    for (const [setting, selected] of settings) {
      if (!setting) {
        continue
      }

      if (value === 'browser') {
        await setting.clear({})
      } else {
        await setting.set({ value: selected })
      }
    }
  } catch (error) {
    for (const [setting, previous] of snapshots) {
      if (previous.levelOfControl === 'controlled_by_this_extension') {
        await setting.set({ value: previous.value }).catch(() => {})
      } else {
        await setting.clear({}).catch(() => {})
      }
    }

    throw error
  }
}

async function fetchConfig(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('errorConfigURL')
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('errorConfigURL')
  }

  let response
  try {
    response = await fetch(url.href, {
      signal: AbortSignal.timeout(30000),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    })
  } catch (error) {
    throw new Error('errorConfigDownload', { cause: error })
  }

  if (!response.ok) {
    throw Object.assign(new Error('errorConfigDownload', { cause: new Error('errorHTTP') }), {
      status: response.status
    })
  }
  if (Number(response.headers.get('content-length')) > 1024 * 1024) {
    throw new Error('errorFileSize')
  }

  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      size += value.byteLength
      if (size > 1024 * 1024) {
        throw new Error('errorFileSize')
      }

      chunks.push(value)
    }
  } catch (error) {
    throw new Error(error.message === 'errorFileSize' ? 'errorFileSize' : 'errorConfigDownload', {
      cause: error
    })
  } finally {
    await reader.cancel().catch(() => {})
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }

  const data = new TextDecoder().decode(bytes)
  M.importProfiles(data)
  return data
}

async function publishSync() {
  if (!syncOptions.enabled || !api.storage.sync) {
    return
  }

  let writtenKeys = []
  let published = false
  try {
    const config = {
      profiles: state.profiles.map(p => {
        const copy = M.profile({ ...p, portable: undefined })
        if (!syncOptions.includePasswords) {
          delete copy.password
        }

        return copy
      })
    }
    // Activation, statistics, cached lists, permissions and sync consent stay on this device.
    delete config.activeProfileId
    const text = JSON.stringify({
      config,
      preferences: {
        theme: state.theme,
        language: state.language,
        webRTC: state.webRTC,
        bypassLocalNetworks: state.bypassLocalNetworks,
        routing: M.routing(state.browserRouting)
      }
    })
    if (new TextEncoder().encode(text).length > 45000) {
      throw new Error('errorSyncSize')
    }

    const revision = crypto.randomUUID()
    const parts = text.match(/[\s\S]{1,1500}/gu) || ['']
    const previous = await api.storage.sync.get(null)
    const chunks = Object.fromEntries(
      parts.map((part, index) => [`mega:${revision}:${index}`, part])
    )
    // Publish a pointer only after every chunk has been stored successfully.
    writtenKeys = Object.keys(chunks)
    await api.storage.sync.set(chunks)
    await api.storage.sync.set({ megaConfig: { revision, count: parts.length } })
    published = true
    syncRevision = revision
    // Unpublished chunks may belong to another writer still preparing its pointer.
    const previousRevision = previous.megaConfig?.revision
    await api.storage.sync.remove(
      Object.keys(previous).filter(
        key =>
          typeof previousRevision === 'string' &&
          key.startsWith(`mega:${previousRevision}:`) &&
          !Object.hasOwn(chunks, key)
      )
    )
    syncError = undefined
  } catch (error) {
    if (!published && writtenKeys.length) {
      await api.storage.sync.remove(writtenKeys).catch(() => {})
    }

    syncError = /^errorSync/.test(error.message) ? error.message : 'errorSync'
    syncErrorDetails = MegaErrors.details(new Error(syncError, { cause: error }), 'sync')
    diagnosticLog?.write('sync_failed', syncErrorDetails)
  }
}

async function receiveSync() {
  if (!syncOptions.enabled || !api.storage.sync) {
    return
  }

  try {
    const data = await api.storage.sync.get(null)
    const pointer = data.megaConfig
    if (!pointer || pointer.revision === syncRevision) {
      return
    }

    if (
      typeof pointer.revision !== 'string' ||
      !Number.isInteger(pointer.count) ||
      pointer.count < 1 ||
      pointer.count > 60
    ) {
      throw new Error('errorSync')
    }

    const parts = Array.from(
      { length: pointer.count },
      (_, i) => data[`mega:${pointer.revision}:${i}`]
    )
    if (
      parts.some(p => typeof p !== 'string') ||
      new TextEncoder().encode(parts.join('')).length > 45000
    ) {
      throw new Error('errorSync')
    }

    const payload = JSON.parse(parts.join(''))
    const config = structuredClone(payload.config)
    if (!syncOptions.includePasswords && Array.isArray(config?.profiles)) {
      for (const p of config.profiles) {
        delete p.password
        if (p.proxy) {
          delete p.proxy.password
        }
      }
    }

    if (
      !config ||
      !Array.isArray(config.profiles) ||
      config.profiles.length > 1000 ||
      config.profiles.some(p => typeof p.id !== 'string' || !p.id.trim())
    ) {
      throw new Error('errorSync')
    }

    const imported = config.profiles.length
      ? { profiles: config.profiles.map(p => M.profile(p)), skipped: [], missingPasswords: [] }
      : undefined
    if (imported) {
      if (
        imported.skipped.length ||
        new Set(imported.profiles.map(p => p.id)).size !== imported.profiles.length
      ) {
        throw new Error('errorSync')
      }

      imported.missingPasswords = config.profiles
        .filter(p => !Object.hasOwn(p, 'password'))
        .map(p => p.id)
    }

    let next = config.profiles.length
      ? M.mergeImport(
          state,
          imported,
          state.profiles
            .filter(p => !config.profiles.some(incoming => incoming.id === p.id))
            .map(p => p.id)
        )
      : { ...state, profiles: [], activeId: null }
    if (imported) {
      const merged = new Map(next.profiles.map(p => [p.id, p]))
      next.profiles = imported.profiles.map(p => merged.get(p.id))
    }

    const preferences = payload.preferences || {}
    const routing = M.routing(preferences.routing)

    if (platform.downgradeRouting(routing)) {
      startupError = 'splitUnsupportedWarning'
    }

    if (
      !['auto', 'ru', 'en'].includes(preferences.language) ||
      !['system', 'light', 'dark'].includes(preferences.theme) ||
      typeof preferences.bypassLocalNetworks !== 'boolean'
    ) {
      throw new Error('errorSync')
    }

    next = {
      ...next,
      browserRouting: routing,
      theme: preferences.theme,
      language: preferences.language,
      bypassLocalNetworks: preferences.bypassLocalNetworks,
      webRTC: M.webRTC(preferences.webRTC || 'browser')
    }
    // Unsupported privacy options remain local; imports never grant privacy permission.
    if (
      !platform.supportsWebRTC(next.webRTC) ||
      (next.webRTC !== 'browser' &&
        api.permissions?.contains &&
        !(await api.permissions.contains({ permissions: ['privacy'] })))
    ) {
      next.webRTC = state.webRTC
    }

    const old = state
    state = next
    try {
      await apply(next)
      if (old.webRTC !== next.webRTC) {
        await applyWebRTC(next.webRTC)
      }

      await api.storage.local.set({ state: next })
    } catch (error) {
      state = old
      await apply(old).catch(() => {})
      await applyWebRTC(old.webRTC).catch(() => {})
      throw error
    }

    tabOverrides.clear()
    connectionCheck = null
    await storeConnectionCheck()
    if (
      old.activeId !== next.activeId ||
      JSON.stringify(M.active(old)) !== JSON.stringify(M.active(next))
    ) {
      await startKnock().catch(error => {
        recordStartupError(error)
      })
    }

    syncRevision = pointer.revision
    syncError = undefined
    await rebuildMenus()
    await refreshBadges()
    await scheduleSubscriptions()
    const settingsChanged =
      JSON.stringify(old.browserRouting.subscriptions) !==
      JSON.stringify(next.browserRouting.subscriptions)
    queue = queue.then(() => refreshSubscriptions(settingsChanged)).catch(() => {})
  } catch (error) {
    syncError = 'errorSync'
    syncErrorDetails = MegaErrors.details(new Error(syncError, { cause: error }), 'sync')
    diagnosticLog?.write('sync_failed', syncErrorDetails)
  }
}

async function rebuildMenus() {
  if (!api.contextMenus) {
    return
  }

  await api.contextMenus.removeAll()
  let catalog
  if (['ru', 'en'].includes(state.language)) {
    if (!menuCatalogs.has(state.language)) {
      const messages = await fetch(api.runtime.getURL(`_locales/${state.language}/messages.json`))
        .then(r => r.json())
        .catch(() => ({}))
      menuCatalogs.set(state.language, messages)
    }

    catalog = menuCatalogs.get(state.language)
  }

  const title = key => catalog?.[key]?.message || api.i18n.getMessage(key) || key

  api.contextMenus.create({ id: 'megaproxy', title: 'MegaProxy', contexts: ['page', 'action'] })
  for (const [id, key] of [
    ['addCurrentSite', 'addCurrentSite'],
    ['excludeCurrentSite', 'excludeCurrentSite'],
    ['disconnect', 'disconnect'],
    ['direct', 'modeDirect'],
    ['system', 'modeSystem'],
    ['settings', 'openSettings']
  ]) {
    api.contextMenus.create({
      id,
      parentId: 'megaproxy',
      title: title(key),
      contexts: ['page', 'action']
    })
  }

  for (const [id, key] of platform.tabMenus) {
    api.contextMenus.create({
      id,
      parentId: 'megaproxy',
      title: title(key),
      contexts: ['page', 'action']
    })
  }

  for (const p of state.profiles) {
    api.contextMenus.create({
      id: `profile:${p.id}`,
      parentId: 'megaproxy',
      title: `${title('connect')}: ${p.name || p.host}`,
      contexts: ['page', 'action']
    })
  }
}

api.contextMenus?.onClicked.addListener((info, tab) => {
  queue = queue
    .then(async () => {
      await ready
      if (['direct', 'system'].includes(info.menuItemId)) {
        return handle({ command: 'connectionMode', mode: info.menuItemId })
      }

      if (info.menuItemId === 'settings') {
        return api.runtime.openOptionsPage()
      }

      const command = info.menuItemId
      return handle(
        command.startsWith('profile:')
          ? { command: 'activate', id: command.slice(8) }
          : command === 'disconnect'
            ? { command: 'activate', id: null }
            : { command, tab }
      )
    })
    .catch(error => {
      recordStartupError(error)
    })
})

api.storage.onChanged?.addListener((changes, area) => {
  if (
    area === 'sync' &&
    (changes.megaConfig || Object.keys(changes).some(key => key.startsWith('mega:')))
  ) {
    queue = queue
      .then(async () => {
        await ready
        await receiveSync()
      })
      .catch(() => {})
  }
})

queue = queue
  .then(async () => {
    await ready
    diagnosticLog?.write('background_started', { mode: state.connectionMode })
    if (recoverTransientProxy || routingMigration) {
      await apply(state)
      await api.storage.session?.set({ assignedKnockLease: false, transientProxyLease: false })
      if (routingMigration) {
        await api.storage.local.set({ state })
      }
    }

    for (const pending of [...knockTabs]) {
      const tab = await api.tabs.get(pending.tabId).catch(() => null)
      if (!tab) {
        await updateKnockTab(pending.tabId, { closed: true })
      } else if (tab.status === 'complete') {
        await updateKnockTab(tab.id, { loaded: true, url: tab.url })
      }
    }

    await receiveSync()
    if (
      syncOptions.enabled &&
      api.storage.sync &&
      !syncRevision &&
      !syncError &&
      state.profiles.length
    ) {
      await publishSync()
    }

    await applyWebRTC(state.webRTC).catch(error => {
      recordStartupError(error, 'webRTC')
    })
    await rebuildMenus()
  })
  .catch(error => {
    recordStartupError(error)
  })

const toolbarPaths = Object.fromEntries(
  [16, 24, 32, 48, 64].map(size => [size, `icons/toolbar${size}.png`])
)
const toolbarIcons = new Map()
const badgeVersions = new Map()
let toolbarBitmaps

function toolbarIcon(color) {
  if (!toolbarIcons.has(color)) {
    toolbarBitmaps ||= Promise.all(
      Object.entries(toolbarPaths).map(async ([size, path]) => {
        try {
          const response = await fetch(api.runtime.getURL(path))
          if (!response.ok) {
            throw Object.assign(new Error('errorHTTP'), { status: response.status })
          }
          return [Number(size), await createImageBitmap(await response.blob())]
        } catch (error) {
          const failure = MegaErrors.context(
            Object.assign(new Error('errorIcon', { cause: error }), {
              resource: path.split('/').at(-1)
            }),
            'toolbarIcon'
          )
          diagnosticLog?.write('icon_load_failed', failure.errorDetails)
          throw failure
        }
      })
    ).catch(error => {
      toolbarBitmaps = undefined
      toolbarIcons.clear()
      throw error
    })
    toolbarIcons.set(
      color,
      toolbarBitmaps.then(bitmaps => {
        return Object.fromEntries(
          bitmaps.map(([size, bitmap]) => {
            const canvas = new OffscreenCanvas(size, size)
            const ctx = canvas.getContext('2d')
            ctx.drawImage(bitmap, 0, 0, size, size)
            ctx.scale(size / 16, size / 16)
            ctx.beginPath()
            ctx.arc(12.5, 12.5, 3, 0, Math.PI * 2)
            ctx.globalCompositeOperation = 'destination-out'
            ctx.lineWidth = 3
            ctx.stroke()
            ctx.globalCompositeOperation = 'source-over'
            ctx.fillStyle = color
            ctx.fill()
            ctx.strokeStyle = '#ffffff'
            ctx.lineWidth = 1
            ctx.stroke()
            return [size, ctx.getImageData(0, 0, size, size)]
          })
        )
      })
    )
  }
  return toolbarIcons.get(color)
}

async function updateBadge(tabId, url) {
  if (!api.action?.setBadgeText) {
    return
  }

  const version = (badgeVersions.get(tabId) || 0) + 1
  badgeVersions.set(tabId, version)
  await ready
  if (!url) {
    url = (await api.tabs.get(tabId).catch(() => null))?.url
  }

  let p
  try {
    if (!/^https?:\/\//i.test(url || '')) {
      p = M.active(state)
    } else if (M.routed(url, state, url, tabOverrides.get(tabId))) {
      p = M.routeProfile(url, state, url, tabOverrides.get(tabId))
    }
  } catch {}

  const label = p
    ? p.name || p.host
    : state.connectionMode === 'system' || (!M.active(state) && state.connectionMode !== 'direct')
      ? 'SYSTEM'
      : 'DIRECT'
  const color = p ? M.colors[p.color % M.colors.length] : label === 'SYSTEM' ? '#616161' : '#bdbdbd'
  const icon = { tabId, imageData: await toolbarIcon(color) }
  if (badgeVersions.get(tabId) !== version) {
    return
  }
  await Promise.all([
    api.action.setBadgeText({ tabId, text: '' }),
    api.action.setIcon(icon),
    api.action.setTitle({
      tabId,
      title: `MegaProxy · ${label}${p ? `\n${p.type.toUpperCase()} · ${p.host}:${p.port}` : ''}`
    })
  ])
}

async function refreshBadges() {
  if (!api.action?.setBadgeText) {
    return
  }

  const tabs = await api.tabs.query({})
  await Promise.all(tabs.map(tab => updateBadge(tab.id, tab.url)))
}
