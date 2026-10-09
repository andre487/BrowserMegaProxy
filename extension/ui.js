/* global MegaErrors, chrome, MegaProxy, MegaI18n, MegaSubscriptions, MegaPlatform, MEGA_TARGET */
const api = globalThis.browser || chrome
const platform = MegaPlatform.create(MEGA_TARGET, api)

const $ = selector => document.querySelector(selector)

const t = MegaI18n.t

const isOptions = Boolean($('#profile-form'))

let state
let busy = false
let statistics
let statisticsTimer
let connectionCheck
let pendingImport
let currentSite
let syncOptions = { enabled: true, includePasswords: true }
let syncError
let syncErrorDetails
let routingDrafts
let draggingProfile = false
let routingDraftMode
let routingSaves = Promise.resolve()
let routingSaving = false
let renderedRoutingConfig
let privateAccess

function renderPrivateAccess() {
  $('#private-access-status').textContent = t(
    privateAccess === undefined
      ? 'privateAccessUnknown'
      : privateAccess
        ? 'privateAccessAllowed'
        : 'privateAccessDenied'
  )
  $('#private-access-hint').textContent = t(
    platform.id === 'firefox' ? 'privateAccessFirefoxHint' : 'privateAccessChromiumHint'
  )
  $('#private-access-hint').hidden = privateAccess === true
}

async function refreshPrivateAccess() {
  try {
    privateAccess = await api.extension.isAllowedIncognitoAccess()
  } catch {
    privateAccess = undefined
  }
  renderPrivateAccess()
}

async function send(command, extra = {}) {
  const result = await api.runtime.sendMessage({ command, ...extra }).catch(error => {
    throw MegaErrors.context(error, command)
  })
  if (!result?.ok) {
    const error = new Error(result?.error || 'errorBackground')
    error.errorDetails = result?.errorDetails || MegaErrors.details(error, command)
    throw error
  }

  if (result.syncOptions) {
    syncOptions = result.syncOptions
  }

  if (Object.hasOwn(result, 'syncError')) {
    syncError = result.syncError
    syncErrorDetails = result.syncErrorDetails
  }

  if (command === 'get' || command === 'telemetry') {
    statistics = result.statistics
    if (command === 'telemetry') {
      renderStatistics()
    }
  }

  if (Object.hasOwn(result, 'currentSite')) {
    currentSite = result.currentSite
    renderSite()
  }

  if (Object.hasOwn(result, 'connectionCheck')) {
    connectionCheck = result.connectionCheck
    renderCheck()
  }

  if (result.state) {
    state = result.state
    render()
    if (!isOptions && command !== 'currentSite') {
      await send('currentSite')
    }
  }

  if (result.warning) {
    $('#notice').textContent = MegaErrors.format(
      { message: result.warning, errorDetails: result.warningDetails },
      'startup',
      t
    )
    $('#notice').className = 'error'
  }

  return result
}

async function action(fn, operation = 'interface') {
  if (busy) {
    return
  }

  busy = true
  for (const notice of document.querySelectorAll('.dialog-error')) {
    notice.textContent = ''
  }
  $('#notice').textContent = ''
  $('#notice').className = ''

  try {
    await fn()
  } catch (error) {
    $('#notice').textContent = MegaErrors.format(error, operation, t)
    $('#notice').className = 'error'
    const dialogNotice = document.querySelector('dialog[open] .dialog-error')
    if (dialogNotice) {
      dialogNotice.textContent = MegaErrors.format(error, operation, t)
    }
  } finally {
    busy = false
    renderCheck()
    document.body.hidden = false
  }
}

function button(label, fn, className = 'secondary') {
  const element = document.createElement('button')
  element.textContent = label
  element.className = className
  element.onclick = () => action(fn)

  return element
}

function icon(name) {
  const paths = {
    edit: 'M16 3l5 5-12 12H4v-5L16 3zM14 5l5 5',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    settings:
      'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3zM16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z',
    check: 'M5 12l4 4L19 6'
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.classList.add('icon')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', name === 'more' ? '4' : '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const path = document.createElementNS(svg.namespaceURI, 'path')
  path.setAttribute('d', paths[name])
  svg.append(path)
  return svg
}

function edit(p = {}) {
  const form = $('#profile-form')
  form.reset()

  for (const [key, value] of Object.entries(p)) {
    if (form.elements.namedItem(key)) {
      form.elements.namedItem(key).value = Array.isArray(value) ? value.join(', ') : value
    }
  }

  $('#editor').showModal()
  syncKnock()
  form.elements.name.focus()
}

function render() {
  if (draggingProfile) {
    return
  }

  MegaI18n.apply(state.language || 'auto')
  renderStatistics()
  if ($('#connection-mode')) {
    $('#connection-mode').value = MegaProxy.active(state)
      ? 'proxy'
      : state.connectionMode === 'direct'
        ? 'direct'
        : 'system'
  }

  if (isOptions) {
    renderPrivateAccess()
    $('#webrtc').value = state.webRTC || 'browser'
    for (const option of $('#webrtc').options) {
      option.hidden = !platform.supportsWebRTC(option.value)
    }

    $('#sync-enabled').checked = syncOptions.enabled
    $('#sync-passwords').checked = syncOptions.includePasswords
    $('#sync-passwords').disabled = !syncOptions.enabled
    $('#sync-status').textContent = syncError
      ? MegaErrors.format({ message: syncError, errorDetails: syncErrorDetails }, 'sync', t)
      : ''
    $('#language').value = state.language || 'auto'
    $('#theme').value = platform.themePreference(state.theme)
    renderThemeHint()
    $('#masque-setting').hidden = platform.id !== 'firefox'
    $('#masque-enabled').checked = state.masqueEnabled === true
    $('#statistics-enabled').checked = state.statisticsEnabled === true
    $('#bypass-local').checked = state.bypassLocalNetworks !== false
  }

  document.documentElement.dataset.theme = platform.themePreference(state.theme)

  const active = MegaProxy.active(state)
  if (!isOptions) {
    $('#connection').classList.toggle('has-profile', Boolean(active))
    $('#connection').style.setProperty(
      '--profile-color',
      active ? MegaProxy.colors[active.color % MegaProxy.colors.length] : ''
    )
    $('#connection').textContent = active
      ? t('profileLabel', active.name || active.host)
      : t(state.connectionMode === 'direct' ? 'modeDirect' : 'modeSystem')
    $('#endpoint').textContent = active
      ? `${active.type.toUpperCase()} · ${active.host}:${active.port}`
      : ''
    $('#disconnect').disabled = !active
  }

  $('#profiles').replaceChildren()
  $('#empty').hidden = !!state.profiles.length

  for (const p of state.profiles) {
    const card = document.createElement('article')
    card.style.borderLeft = `4px solid ${MegaProxy.colors[p.color % MegaProxy.colors.length]}`
    card.dataset.profileId = p.id
    const selected = p.id === active?.id
    card.className = `profile${selected ? ' active' : ''}`

    const info = document.createElement('div')
    info.className = 'profile-info'
    const title = document.createElement('strong')
    const flag = countryFlag(p.countryCode)
    title.textContent = `${flag} ${p.name || p.host}`.trim()

    const endpoint = document.createElement('p')
    endpoint.textContent = `${p.type.toUpperCase()} · ${p.host}:${p.port}${selected ? ` · ${t('active')}` : ''}`
    endpoint.title = endpoint.textContent
    info.append(title, endpoint)

    const actions = document.createElement('div')
    actions.className = 'actions'
    const select = button(t(selected ? 'selectedProfile' : 'connect'), () =>
      send('activate', { id: p.id })
    )
    select.disabled = selected
    if (isOptions) {
      const editButton = button(t('edit'), () => edit(p))
      editButton.prepend(icon('edit'))
      const menu = document.createElement('details')
      menu.className = 'profile-menu'
      const summary = document.createElement('summary')
      summary.setAttribute('aria-label', `${t('profileActions')}: ${p.name || p.host}`)
      summary.title = t('profileActions')
      summary.append(icon('more'))
      const items = document.createElement('div')
      items.append(
        button(t('clone'), () =>
          send('clone', { id: p.id, name: t('copyName', p.name || p.host) })
        ),
        button(t('delete'), () => send('delete', { id: p.id }), 'danger')
      )
      menu.append(summary, items)
      actions.append(editButton, select, menu)
    } else {
      actions.append(select)

      if (p.knockHost && p.id === state.activeId) {
        const knock = button(t('knock'), async () => {
          $('#notice').textContent = t((await send('knock')).message)
        })
        knock.disabled = !platform.needsKnock(p)
        actions.append(knock)
      }
    }

    if (isOptions) {
      card.append(profileDragHandle(card, p))
    }
    card.append(info, actions)
    $('#profiles').append(card)
  }

  if (isOptions) {
    syncKnock()
    renderRouting()
    renderNetworkActions()
  } else {
    renderSite()
  }

  renderCheck()
  for (const [selector, name] of [
    ['#check', 'check'],
    ['#open-settings', 'settings']
  ]) {
    const control = $(selector)
    if (control && !control.querySelector('svg')) {
      control.prepend(icon(name))
    }
    if (selector === '#open-settings' && control) {
      control.setAttribute('aria-label', t('openSettings'))
      control.title = t('openSettings')
    }
  }
}

function profileDragHandle(card, profile) {
  const handle = document.createElement('button')
  handle.type = 'button'
  handle.className = 'secondary profile-drag'
  handle.textContent = '⠿'
  handle.setAttribute('aria-label', t('reorderProfile', profile.name || profile.host))
  handle.title = t('reorderProfileHint')
  handle.onkeydown = event => {
    const direction = { ArrowUp: -1, ArrowDown: 1 }[event.key]
    if (!direction) {
      return
    }

    event.preventDefault()
    const index = state.profiles.findIndex(p => p.id === profile.id)
    if (index + direction >= 0 && index + direction < state.profiles.length) {
      action(async () => {
        await send('move', { id: profile.id, direction })
        $(`[data-profile-id="${CSS.escape(profile.id)}"] .profile-drag`).focus()
      })
    }
  }
  handle.onpointerdown = event => {
    if (event.button !== 0 || draggingProfile) {
      return
    }

    handle.setPointerCapture(event.pointerId)
    draggingProfile = true
    card.classList.add('dragging')
    let pointerY = event.clientY
    let frame
    const update = () => {
      const others = [...$('#profiles').children].filter(item => item !== card)
      const before = others.find(item => {
        const rect = item.getBoundingClientRect()
        const translation = new DOMMatrixReadOnly(getComputedStyle(item).transform).m42
        return pointerY < rect.top - translation + rect.height / 2
      })
      if (card.nextElementSibling !== (before || null)) {
        const positions = matchMedia('(prefers-reduced-motion: reduce)').matches
          ? []
          : others.map(item => [item, item.getBoundingClientRect().top])
        for (const [item] of positions) {
          for (const animation of item.getAnimations()) {
            animation.cancel()
          }
        }
        $('#profiles').insertBefore(card, before || null)
        handle.setPointerCapture(event.pointerId)
        for (const [item, top] of positions) {
          const offset = top - item.getBoundingClientRect().top
          if (offset) {
            item.animate(
              [{ transform: `translateY(${offset}px)` }, { transform: 'translateY(0)' }],
              { duration: 180, easing: 'ease-out' }
            )
          }
        }
      }
      if (pointerY < 64 || pointerY > innerHeight - 64) {
        window.scrollBy(0, pointerY < 64 ? -12 : 12)
      }
      frame = requestAnimationFrame(update)
    }
    handle.onpointermove = move => {
      pointerY = move.clientY
    }
    const finish = end => {
      cancelAnimationFrame(frame)
      handle.onpointermove = handle.onpointerup = handle.onpointercancel = null
      draggingProfile = false
      const position = [...$('#profiles').children].indexOf(card)
      render()
      if (end.type !== 'pointercancel') {
        action(() => send('move', { id: profile.id, position }))
      }
    }
    handle.onpointerup = handle.onpointercancel = finish
    frame = requestAnimationFrame(update)
  }
  return handle
}

function routingSignature(config) {
  return JSON.stringify([config, state.profiles.map(({ id, name, host }) => [id, name, host])])
}

function renderRouting() {
  if (routingSaving) {
    return
  }

  const config = state.browserRouting || MegaProxy.routing()
  const signature = routingSignature(config)
  if (renderedRoutingConfig === signature) {
    const selected = new Set(
      [...$('#subscription-sources').querySelectorAll('input:checked')].map(input => input.value)
    )
    const autoUpdate = $('#lists-auto').checked
    const throughProxy = $('#lists-proxy').checked
    renderSubscriptions('domains')
    for (const input of $('#subscription-sources').querySelectorAll('input')) {
      input.checked = selected.has(input.value)
    }
    $('#lists-auto').checked = autoUpdate
    $('#lists-proxy').checked = throughProxy
    renderRoutingMode()
    return
  }
  renderedRoutingConfig = signature
  $('#routing-mode').value = MegaProxy.routingStrategy(config)
  $('#routing-mode').setAttribute('aria-label', t('routingMode'))
  routingDrafts = { domains: config.domains.join('\n'), tabs: config.sites.join('\n') }
  routingDraftMode = config.mode
  $('#routing-mode option[value="tabs"]').hidden = !platform.supportsTabRouting
  const tabs = config.mode === 'tabs'
  $('#routing-list').value = config[tabs ? 'sites' : 'domains'].join('\n')
  $('#routing-list-label').dataset.i18n = tabs ? 'routingSiteList' : 'routingDomainList'
  $('#routing-list-label').textContent = t(tabs ? 'routingSiteList' : 'routingDomainList')
  $('#routing-hint').textContent = t(platform.routingHint(tabs ? 'tabs' : 'domains'))
  renderSubscriptions('domains')
  renderRoutingMode()
}

function renderRoutingMode() {
  const strategy = $('#routing-mode').value
  const tabs = strategy === 'tabs'
  $('#rule-tab-url').closest('label').hidden = !platform.supportsTabRouting || !tabs
  $('#manual-routing').hidden = !['manual', 'tabs'].includes(strategy)
  $('#list-routing').hidden = strategy !== 'lists'
  $('#routing-list-label').dataset.i18n = tabs ? 'routingSiteList' : 'routingDomainList'
  $('#routing-list-label').textContent = t(tabs ? 'routingSiteList' : 'routingDomainList')
  $('#routing-patterns-hint').textContent = t(
    platform.supportsTabRouting ? 'routingPatternsHint' : 'routingDomainPatternsHint'
  )
  $('#routing-hint').textContent =
    strategy === 'all' ? t('routingAllHint') : t(platform.routingHint(tabs ? 'tabs' : 'domains'))
}

function saveRouting() {
  const strategy = $('#routing-mode').value
  const mode = strategy === 'tabs' ? 'tabs' : 'domains'
  routingDrafts[routingDraftMode] = $('#routing-list').value
  const message = {
    routing: {
      ...(state.browserRouting || MegaProxy.routing()),
      enabled: strategy !== 'all',
      mode,
      strategy: strategy === 'all' ? 'manual' : strategy,
      domains: routingDrafts.domains.split(/[\s,]+/).filter(Boolean),
      sites: routingDrafts.tabs.split(/[\s,]+/).filter(Boolean),
      subscriptions: {
        ...MegaSubscriptions.options(state.browserRouting?.subscriptions),
        autoUpdate: $('#lists-auto').checked,
        throughProxy: $('#lists-proxy').checked,
        domainSources: [...$('#subscription-sources').querySelectorAll('input:checked')].map(
          input => input.value
        )
      }
    }
  }

  routingSaves = routingSaves.then(async () => {
    routingSaving = true
    try {
      await send('routing', message)
      renderedRoutingConfig = routingSignature(state.browserRouting || MegaProxy.routing())
      $('#notice').textContent = ''
      $('#notice').className = ''
    } catch (error) {
      $('#notice').textContent = MegaErrors.format(error, 'interface', t)
      $('#notice').className = 'error'
    } finally {
      routingSaving = false
    }
  })
  return routingSaves
}

function savePreference(command, message) {
  routingSaves = routingSaves
    .then(() => send(command, message))
    .catch(error => {
      $('#notice').textContent = MegaErrors.format(error, 'interface', t)
      $('#notice').className = 'error'
    })
  return routingSaves
}

function renderThemeHint() {
  $('#theme-hint').textContent =
    platform.defaultTheme === 'dark'
      ? t('themeChromiumHint')
      : t('themeHint') +
        ' ' +
        t(
          'themeDetected',
          t(
            matchMedia('(prefers-color-scheme: dark)').matches
              ? 'dark'
              : matchMedia('(prefers-color-scheme: light)').matches
                ? 'light'
                : 'themeUnknown'
          )
        )
}

async function reviewImport(data) {
  const preview = await send('previewImport', { data })
  pendingImport = data
  $('#import-warnings').textContent = [
    preview.skippedMasque ? t('masqueImportDisabled') : '',
    preview.skipped.length ? t('importSkipped', preview.skipped.join(', ')) : '',
    preview.unknownFields ? t('unknownConfigFields') : '',
    preview.unsupportedSplitProxy ? t('splitUnsupportedWarning') : '',
    preview.unsupportedWebRTC ? t('errorWebRTCUnsupported') : ''
  ]
    .filter(Boolean)
    .join(' ')
  $('#import-summary').textContent = t(
    'importSummary',
    preview.added,
    preview.updated,
    preview.skipped.length
  )
  $('#import-absent').replaceChildren()
  for (const p of preview.absent) {
    const label = document.createElement('label')
    label.className = 'checkbox'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.value = p.id
    label.append(checkbox, document.createTextNode(p.name))
    $('#import-absent').append(label)
  }

  $('#import-review').hidden = false
  $('#apply-import').focus()
}

function renderSubscriptions(mode) {
  const config = state.browserRouting || MegaProxy.routing()
  const settings = MegaSubscriptions.options(config.subscriptions)
  const key = mode === 'tabs' ? 'siteSources' : 'domainSources'
  $('#subscription-sources').replaceChildren()
  const sources = MegaSubscriptions.catalog(state.subscriptionCatalog)
  const missing = settings[key]
    .filter(id => !sources.some(source => source.id === id))
    .map(id => ({ id, name: t('listUnavailable', id) }))
  for (const source of [...sources, ...missing]) {
    const label = document.createElement('label')
    label.className = 'checkbox'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.value = source.id
    checkbox.checked = settings[key].includes(source.id)
    label.append(checkbox, document.createTextNode(source.name))
    $('#subscription-sources').append(label)
  }

  $('#lists-auto').checked = settings.autoUpdate
  $('#lists-proxy').checked = settings.throughProxy
  $('#update-lists').disabled = false
  const cache = state.subscriptionCache
  const valid = cache?.sourceKey === MegaSubscriptions.sourceKey(settings)
  $('#lists-status').textContent =
    valid && cache.updatedAt
      ? t(
          'listsUpdated',
          new Date(cache.updatedAt).toLocaleString(document.documentElement.lang),
          MegaProxy.routingPatterns(state, mode === 'tabs' ? 'sites' : 'domains').length
        )
      : t('listsNotUpdated')
  const counts = MegaSubscriptions.counts(state, mode === 'tabs' ? 'sites' : 'domains')
  $('#lists-warning').textContent = [
    state.subscriptionCatalog?.error
      ? MegaErrors.format(
          {
            message: state.subscriptionCatalog.error,
            errorDetails: state.subscriptionCatalog.errorDetails
          },
          'routingOpened',
          t
        )
      : '',
    cache?.error
      ? MegaErrors.format(
          { message: cache.error, errorDetails: cache.errorDetails },
          'updateSubscriptions',
          t
        )
      : '',
    ...(valid
      ? (cache.coverage?.[mode === 'tabs' ? 'sites' : 'domains'] || []).map(item => {
          const sources = MegaSubscriptions.catalog(state.subscriptionCatalog)
          return t(
            'listsCovered',
            sources.find(source => source.id === item.sourceId)?.name || item.sourceId,
            sources.find(source => source.id === item.coveredBy)?.name || item.coveredBy
          )
        })
      : []),
    cache?.rankingError
      ? MegaErrors.format(
          { message: cache.rankingError, errorDetails: cache.rankingErrorDetails },
          'updateSubscriptions',
          t
        )
      : '',
    counts?.dropped ? t('listsTruncated', counts.dropped, MegaSubscriptions.limit) : '',
    counts?.dropped && counts.unranked ? t('listsUnranked', counts.unranked) : '',
    cache?.ignored ? t('listsIgnored', cache.ignored) : ''
  ]
    .filter(Boolean)
    .join(' ')
}

function renderSite() {
  if (isOptions || !state) {
    return
  }

  const config = state.browserRouting || MegaProxy.routing()
  const hasSite = Boolean(currentSite)
  const active = MegaProxy.active(state)
  const profile = state.profiles.find(p => p.id === currentSite?.profileId)
  $('#site-actions').hidden =
    ['direct', 'system'].includes(state.connectionMode) || (Boolean(active) && !config.enabled)
  $('#current-site').textContent = hasSite ? currentSite.hostname : t('noCurrentSite')
  $('#routing-summary').hidden = !hasSite
  $('#routing-summary').textContent = currentSite?.proxied
    ? profile
      ? t('siteProxyProfile', profile.name || profile.host)
      : t('siteProxy')
    : !active && state.connectionMode !== 'direct'
      ? t('siteSystem')
      : t('siteDirect')
  $('#site-connect-hint').hidden = !hasSite || Boolean(active)
  $('#site-actions .actions').hidden = !hasSite
  $('#add-current-site').disabled = !hasSite || !active
  $('#add-current-site').title = t('addCurrentSiteHint')
  const cache = state.subscriptionCache
  $('#site-warning').textContent =
    hasSite && cache?.error
      ? MegaErrors.format(
          { message: cache.error, errorDetails: cache.errorDetails },
          'updateSubscriptions',
          t
        )
      : ''
  $('#site-warning').hidden = !$('#site-warning').textContent
  $('#toggle-tab').hidden =
    !platform.supportsTabRouting || config.mode !== 'tabs' || !config.enabled
  $('#toggle-tab').disabled = !currentSite || !MegaProxy.active(state)
  $('#toggle-tab').textContent = t(currentSite?.proxied ? 'tabDirect' : 'tabProxy')
}

function syncKnock() {
  if (!isOptions) {
    return
  }

  const form = $('#profile-form')
  if (platform.id === 'chromium') {
    form.querySelector('option[value=masque]')?.remove()
  }
  const masqueOption = form.querySelector('option[value=masque]')
  if (masqueOption) {
    masqueOption.disabled = state.masqueEnabled !== true
    masqueOption.hidden = state.masqueEnabled !== true
  }
  const masque = form.elements.type.value === 'masque'
  $('#masque-template-field').hidden = !masque
  $('#masque-hint').hidden = !masque
  form.elements.masqueTemplate.disabled = !masque
  form.elements.knockHost.disabled = masque
  const socksWithoutAuth = platform.id === 'chromium' && form.elements.type.value === 'socks5'
  form.elements.username.disabled = socksWithoutAuth || masque
  form.elements.password.disabled = socksWithoutAuth || masque
  $('#socks-auth-hint').hidden = !socksWithoutAuth
  const needed = platform.needsKnock({
    type: form.elements.type.value,
    username: form.elements.username.value,
    password: form.elements.password.value
  })
  $('#knock-hint').textContent = t(
    masque
      ? 'knockMasqueHint'
      : form.elements.type.value === 'socks5'
        ? 'knockSocksHint'
        : needed
          ? 'knockHint'
          : 'knockDisabledHint'
  )
}

function renderStatistics() {
  const enabled = state.statisticsEnabled === true
  $('#statistics').hidden = !enabled
  if ($('#network-panel')) {
    $('#network-panel').hidden = !enabled
    if (!enabled) {
      $('#network-rows').replaceChildren()
    }
  }

  $('#statistics-result').textContent =
    enabled && statistics ? t('statisticsCounts', statistics.completed, statistics.failed) : ''
  if (enabled && !statisticsTimer) {
    statisticsTimer = setInterval(() => {
      if (!document.hidden && !busy) {
        send('telemetry').catch(() => {})
        if (isOptions && $('#network-panel').open) {
          refreshNetwork().catch(() => {})
        }
      }
    }, 5000)
  } else if (!enabled && statisticsTimer) {
    clearInterval(statisticsTimer)
    statisticsTimer = undefined
    statistics = undefined
  }
}

function countryFlag(code) {
  return /^[A-Z]{2}$/.test(code || '')
    ? [...code].map(c => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join('')
    : ''
}

function renderCheck() {
  if (!state) {
    return
  }

  $('#check').disabled = busy
  const check = connectionCheck
  const countryName = /^[A-Z]{2}$/.test(check?.countryCode || '')
    ? new Intl.DisplayNames([document.documentElement.lang], {
        type: 'region',
        fallback: 'none'
      }).of(check.countryCode)
    : undefined
  const profile = state.profiles.find(p => p.id === check?.profileId)
  $('#check-result').classList.toggle('error', check?.stage === 'failed')
  $('#check-result').textContent = !check
    ? ''
    : check.stage === 'complete'
      ? [
          profile
            ? t('profileLabel', profile.name || profile.host)
            : check.mode
              ? t(
                  'profileLabel',
                  t({ proxy: 'modeProxy', direct: 'modeDirect', system: 'modeSystem' }[check.mode])
                )
              : '',
          t(
            'checkSuccess',
            check.exitIp,
            `${countryFlag(check.countryCode)} ${check.countryCode || '—'}${countryName ? ` (${countryName})` : ''}`.trim(),
            check.latencyMs
          )
        ]
          .filter(Boolean)
          .join('\n')
      : check.stage === 'failed'
        ? MegaErrors.format({ message: check.error, errorDetails: check.errorDetails }, 'check', t)
        : t(`checkStage_${check.stage}`)
}

$('#check').onclick = async () => {
  if (busy) {
    return
  }
  await action(async () => {
    try {
      await send('check')
    } catch (error) {
      connectionCheck = {
        stage: 'failed',
        error: error.message,
        errorDetails: MegaErrors.details(error, 'check')
      }
    }
  })
  if (!isOptions) {
    const content = $('.popup-content')
    content.scrollTop = content.scrollHeight
  }
}

if (isOptions) {
  if (platform.defaultTheme !== 'system') {
    $('#theme option[value=system]').remove()
  }
  for (const scheme of ['light', 'dark']) {
    matchMedia(`(prefers-color-scheme: ${scheme})`).addEventListener('change', renderThemeHint)
  }
  $('#cancel-profile').onclick = () => $('#editor').close()
  $('#open-url-import').onclick = () => $('#url-import').showModal()
  $('#cancel-url-import').onclick = () => $('#url-import').close()
  $('#build-version').textContent = globalThis.MegaBuild
    ? `MegaProxy ${globalThis.MegaBuild.version} · ${globalThis.MegaBuild.commit}`
    : ''
  $('#update-lists').onclick = () => action(() => send('updateSubscriptions'))
  $('#routing-settings').addEventListener('toggle', () => {
    if ($('#routing-settings').open) {
      send('routingOpened').catch(error => {
        $('#notice').textContent = MegaErrors.format(error, 'routingOpened', t)
        $('#notice').className = 'error'
      })
    }
  })
  $('#routing-mode').onchange = () => {
    routingDrafts[routingDraftMode] = $('#routing-list').value
    routingDraftMode = $('#routing-mode').value === 'tabs' ? 'tabs' : 'domains'
    $('#routing-list').value = routingDrafts[routingDraftMode]
    renderRoutingMode()
  }
  $('#routing-form').onsubmit = event => event.preventDefault()
  $('#routing-form').onchange = saveRouting
  for (const index of MegaProxy.colors.keys()) {
    const option = document.createElement('option')
    option.value = index
    option.textContent = t(`color${index}`)
    option.dataset.i18n = `color${index}`
    $('#profile-color').append(option)
  }

  $('#network-refresh').onclick = () => action(refreshNetwork)
  $('#network-clear').onclick = () =>
    action(async () => {
      await send('clearNetwork')
      await refreshNetwork()
    })
  $('#network-add').onclick = () =>
    action(async () => {
      const domains = [...$('#network-rows').querySelectorAll('input:checked')].map(
        input => input.value
      )
      if (!domains.length) {
        return
      }

      await send('addFailedDomains', {
        tabId: Number($('#network-tab').value),
        domains: [...new Set(domains)]
      })
      await refreshNetwork()
    })
  $('#network-rows').onchange = renderNetworkActions
  $('#network-tab').onchange = () => action(refreshNetwork, 'network')
  $('#network-failed').onchange = () => action(refreshNetwork, 'network')
  $('#network-panel').ontoggle = () => {
    if ($('#network-panel').open) {
      action(refreshNetwork)
    }
  }
  $('#webrtc').onchange = () =>
    action(async () => {
      const value = $('#webrtc').value
      if (value !== 'browser' && !(await api.permissions.request({ permissions: ['privacy'] }))) {
        throw new Error('errorPrivacyPermission')
      }

      await send('webRTC', { value })
    }, 'webRTC')
  const saveSync = () =>
    action(() =>
      send('sync', {
        enabled: $('#sync-enabled').checked,
        includePasswords: $('#sync-passwords').checked
      })
    )

  $('#masque-enabled').onchange = () =>
    action(async () => {
      await send('masqueEnabled', { enabled: $('#masque-enabled').checked })
      syncKnock()
    })
  $('#sync-enabled').onchange = saveSync
  $('#sync-passwords').onchange = saveSync
  $('#rule-test-form').onsubmit = event => {
    event.preventDefault()
    action(async () => {
      const result = await send('testRule', {
        url: $('#rule-url').value,
        tabUrl:
          platform.supportsTabRouting && $('#routing-mode').value === 'tabs'
            ? $('#rule-tab-url').value
            : undefined
      })
      $('#rule-result').textContent = result.proxied
        ? t('ruleProxy', result.profile.name)
        : t('ruleDirect')
    })
  }
  $('#import-url-form').onsubmit = event => {
    event.preventDefault()
    action(async () => {
      await reviewImport((await send('fetchConfig', { url: $('#config-url').value })).data)
      $('#url-import').close()
      $('#apply-import').focus()
      $('#import-review').scrollIntoView({ block: 'start' })
    })
  }
  $('#new').onclick = () => edit({ color: state.profiles.length % MegaProxy.colors.length })
  $('#profile-form').addEventListener('input', syncKnock)
  $('#statistics-enabled').onchange = () =>
    action(async () => {
      await send('statistics', { enabled: $('#statistics-enabled').checked })
      await send('get')
    })
  $('#bypass-local').onchange = () =>
    action(() => send('bypassLocalNetworks', { enabled: $('#bypass-local').checked }))
  $('#theme').onchange = () => action(() => send('theme', { theme: $('#theme').value }))
  $('#language').onchange = () => action(() => send('language', { language: $('#language').value }))

  $('#profile-form').onsubmit = event => {
    event.preventDefault()
    action(async () => {
      const profile = Object.fromEntries(new FormData(event.target))
      if (profile.type === 'masque' || (platform.id === 'chromium' && profile.type === 'socks5')) {
        profile.username = ''
        profile.password = ''
      }
      const previous = state.profiles.find(p => p.id === profile.id)
      const result = await send('save', { profile })
      const saved = result.state.profiles.find(p => p.id === profile.id)
      $('#editor').close()
      if (
        platform.id === 'chromium' &&
        previous &&
        saved &&
        (previous.username !== saved.username || previous.password !== saved.password)
      ) {
        $('#notice').textContent = t('credentialsRestartChromium')
      }
    })
  }

  $('#open-import').onclick = () => $('#import').click()
  $('#import-file').onclick = () => {
    $('#import-start').close()
    $('#import').click()
  }
  $('#import-from-url').onclick = () => {
    $('#import-start').close()
    $('#url-import').showModal()
  }
  $('#cancel-import-start').onclick = () => $('#import-start').close()
  $('#import').onchange = () =>
    action(async () => {
      const file = $('#import').files[0]
      if (!file) {
        return
      }

      if (file.size > 1024 * 1024) {
        throw new Error('errorFileSize')
      }

      const data = await file.text()
      await reviewImport(data)
      $('#import').value = ''
    }, 'previewImport')
  $('#apply-import').onclick = () =>
    action(async () => {
      const removeIds = [...$('#import-absent').querySelectorAll('input:checked')].map(
        input => input.value
      )
      let webRTC
      try {
        webRTC = JSON.parse(pendingImport)?.browser?.webRTC
      } catch {}

      if (
        webRTC &&
        webRTC !== 'browser' &&
        platform.supportsWebRTC(webRTC) &&
        !(await api.permissions.request({ permissions: ['privacy'] }))
      ) {
        throw new Error('errorPrivacyPermission')
      }

      const result = await send('import', { data: pendingImport, removeIds })
      $('#notice').textContent = result.unsupportedSplitProxy
        ? t('splitUnsupportedWarning')
        : result.skipped?.length
          ? t('importSkipped', result.skipped.join(', '))
          : t('imported')
      $('#import-review').hidden = true
      pendingImport = null
    }, 'import')
  $('#cancel-import').onclick = () => {
    $('#import-review').hidden = true
    pendingImport = null
  }
  $('#export').onclick = () =>
    action(async () => {
      const result = await send('export', { includePasswords: $('#export-passwords').checked })
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(result.config, null, 2) + '\n'], { type: 'application/json' })
      )
      const link = document.createElement('a')
      link.href = url
      link.download = 'MegaProxy.json'
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }, 'export')
} else {
  $('#add-current-site').onclick = () =>
    action(async () => {
      await send('addCurrentSite')
    })
  $('#toggle-tab').onclick = () => action(() => send('toggleTab'))
  $('#disconnect').onclick = () => action(() => send('activate', { id: null }))
  $('#open-settings').onclick = () => action(() => api.runtime.openOptionsPage(), 'get')
  for (const id of ['add-profile', 'import-config']) {
    $(`#${id}`).onclick = () =>
      action(() => api.tabs.create({ url: api.runtime.getURL(`options.html#${id}`) }))
  }
}

$('#connection-mode').onchange = () =>
  savePreference('connectionMode', { mode: $('#connection-mode').value })

api.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'session' && changes.connectionCheck) {
    connectionCheck = changes.connectionCheck.newValue
    renderCheck()
  }

  if (area === 'local' && changes.state?.newValue) {
    MegaI18n.ready.then(() => {
      state = changes.state.newValue
      render()
      send(isOptions ? 'get' : 'currentSite').catch(() => {})
    })
  }
})

action(async () => {
  if (!isOptions) {
    const tab = api.tabs.getCurrent ? await api.tabs.getCurrent() : true
    const mobile = (await api.runtime.getPlatformInfo?.())?.os === 'android'
    document.documentElement.dataset.surface = tab || mobile ? 'tab' : 'popup'
  }
  await MegaI18n.ready
  MegaI18n.apply('auto')
  await send('get')
  if (isOptions) {
    await refreshPrivateAccess()
    window.addEventListener('focus', refreshPrivateAccess)
    const scenario = location.hash
    if (['#add-profile', '#import-config'].includes(scenario)) {
      document.body.hidden = false
      history.replaceState(null, '', location.pathname + location.search)
      if (scenario === '#add-profile') {
        edit({ color: state.profiles.length % MegaProxy.colors.length })
      } else {
        $('#import-start').showModal()
      }
    }
  }
}, 'get')

async function refreshNetwork() {
  if (!state.statisticsEnabled) {
    return
  }

  const checked = new Set(
    [...$('#network-rows').querySelectorAll('input:checked')].map(input => input.value)
  )
  const selected = $('#network-tab').value
  const tabs = await api.tabs.query({})
  $('#network-tab').replaceChildren()
  for (const tab of tabs.filter(tab => /^https?:\/\//.test(tab.url || ''))) {
    const option = document.createElement('option')
    option.value = tab.id
    option.textContent = tab.title || new URL(tab.url).hostname
    $('#network-tab').append(option)
  }

  $('#network-tab').disabled = !$('#network-tab').options.length
  if ($('#network-tab').disabled) {
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = t('networkNoTabs')
    $('#network-tab').append(placeholder)
  }

  if ([...$('#network-tab').options].some(option => option.value === selected)) {
    $('#network-tab').value = selected
  }

  // Refresh resource rows while preserving the user's domain selection.
  const result = $('#network-tab').disabled
    ? { entries: [] }
    : await send('network', { tabId: Number($('#network-tab').value) })
  $('#network-rows').replaceChildren()
  for (const entry of result.entries
    .slice()
    .reverse()
    .filter(entry => !$('#network-failed').checked || entry.failed)) {
    const row = document.createElement('label')
    row.className = 'network-row'
    const text = document.createElement('span')
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.value = entry.domain
    checkbox.dataset.failed = String(entry.failed === true)
    checkbox.disabled = !entry.failed
    checkbox.checked = checked.has(entry.domain)
    const profile = state.profiles.find(p => p.id === entry.profileId)
    text.textContent = `${entry.domain} · ${entry.type || ''} · ${entry.failed ? MegaErrors.format({ message: entry.error, status: entry.status }, 'request', t) : entry.status || 'OK'} · ${profile ? profile.name || profile.host : t('modeDirect')}`
    row.append(checkbox, text)
    $('#network-rows').append(row)
  }

  $('#network-empty').hidden = !!$('#network-rows').children.length
  renderNetworkActions()
}

function renderNetworkActions() {
  const mode = MegaProxy.routingStrategy(state.browserRouting || MegaProxy.routing())
  const allowed = mode === 'manual' || (mode === 'tabs' && platform.supportsTabRouting)
  $('#network-add').hidden = !allowed
  for (const input of $('#network-rows').querySelectorAll('input')) {
    input.hidden = !allowed
    input.disabled = !allowed || input.dataset.failed !== 'true'
  }
  $('#network-add').disabled =
    !$('#network-rows').querySelector('input:checked') || !MegaProxy.active(state)
}

// Native details provide keyboard activation; Escape and outside clicks dismiss the menu.
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    for (const menu of document.querySelectorAll('.profile-menu[open]')) {
      menu.open = false
      menu.querySelector('summary').focus()
    }
  }
})
document.addEventListener('click', event => {
  for (const menu of document.querySelectorAll('.profile-menu[open]')) {
    if (!menu.contains(event.target)) {
      menu.open = false
    }
  }
})
