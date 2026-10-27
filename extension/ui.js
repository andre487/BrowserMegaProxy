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
let pendingSubscription
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
let renderedSubscription

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

async function refreshServiceHistoryPermission() {
  $('#clear-service-history').checked =
    (await api.permissions?.contains?.({ permissions: ['history'] }).catch(() => false)) || false
}

async function refreshNotificationPermission() {
  $('#connection-notifications').checked =
    (await api.permissions?.contains?.({ permissions: ['notifications'] }).catch(() => false)) ||
    false
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

function captureProfileFocus(element) {
  const card = element?.closest('.profile')
  return card
    ? {
        id: card.dataset.profileId,
        index: [...$('#profiles').children].indexOf(card),
        control: element.getAttribute('aria-label') || element.textContent
      }
    : null
}

function restoreProfileFocus(focus) {
  if (!focus || document.querySelector('dialog[open]')) {
    return
  }
  const card =
    $(`[data-profile-id="${CSS.escape(focus.id)}"]`) ||
    $('#profiles').children[Math.min(focus.index, state.profiles.length - 1)]
  const item = [...(card?.querySelectorAll('button, summary') || [])].find(
    control => (control.getAttribute('aria-label') || control.textContent) === focus.control
  )
  const control = item?.closest('.profile-menu')?.querySelector('summary') || item
  if (control && !control.disabled) {
    control.focus()
  } else if (card) {
    const info = card.querySelector('.profile-info')
    info.tabIndex = -1
    info.focus()
  } else {
    $('#new, #add-profile')?.focus()
  }
}

function placeNotice(source) {
  const dialogNotice = source?.closest('dialog')?.querySelector('.dialog-error')
  if (dialogNotice) {
    return dialogNotice
  }
  const scope = source?.closest('details:not(.profile-menu), section, footer')
  if (scope) {
    scope.append($('#notice'))
  } else if (source?.id === 'connection-mode') {
    source.closest('label').after($('#notice'))
  }
  return $('#notice')
}

function highlightAttention(element) {
  element.classList.remove('needs-attention')
  void element.offsetWidth
  element.classList.add('needs-attention')
}

async function action(
  fn,
  operation = 'interface',
  source = document.activeElement,
  exclusive = true
) {
  if (busy && exclusive) {
    return
  }

  if (exclusive) {
    busy = true
  }
  const notice = placeNotice(source)
  const attentionBlock = notice.closest('dialog, details, section') || notice
  attentionBlock.classList.remove('needs-attention')
  const focusedProfile = captureProfileFocus(source)
  const trigger = source?.closest('button')
  const wasDisabled = trigger?.disabled
  const nodes = trigger ? [...trigger.childNodes] : []
  const working = ['downloadConfig', 'updateLists'].includes(trigger?.dataset.i18n)
    ? 'loading'
    : source?.closest('#profile-form, #settings')
      ? 'saving'
      : 'working'
  if (trigger) {
    trigger.disabled = true
    if (
      !trigger.classList.contains('icon-button') &&
      !['check', 'disconnect'].includes(trigger.id)
    ) {
      trigger.textContent = t(working)
    }
  }
  source?.setAttribute('aria-busy', 'true')
  for (const notice of document.querySelectorAll('.dialog-error')) {
    notice.textContent = ''
  }
  $('#notice').textContent = ''
  $('#notice').className = ''
  notice.classList.remove('error')
  const showProgress =
    isOptions && source?.closest('form') && source.id !== 'check' && working !== 'loading'
  if (showProgress) {
    notice.textContent = t(working)
  }

  try {
    await fn()
    if (showProgress && notice.textContent === t(working)) {
      notice.textContent = ''
    }
    if (isOptions && source?.closest('#settings') && !notice.textContent) {
      notice.textContent = t('saved')
    }
  } catch (error) {
    notice.textContent = MegaErrors.format(error, operation, t)
    notice.classList.add('error')
    highlightAttention(attentionBlock)
  } finally {
    if (exclusive) {
      busy = false
    }
    source?.removeAttribute('aria-busy')
    if (trigger?.isConnected) {
      trigger.disabled = wasDisabled
      if (trigger.textContent === t(working)) {
        trigger.replaceChildren(...nodes)
      }
      if (trigger.id === 'disconnect') {
        trigger.disabled = !MegaProxy.active(state)
      }
    }
    renderCheck()
    if (source && !source.isConnected) {
      restoreProfileFocus(focusedProfile)
    }
    document.body.hidden = false
  }
}

function button(label, fn, className = 'secondary', iconName) {
  const element = document.createElement('button')
  element.textContent = label
  element.className = className
  if (iconName) {
    element.replaceChildren(icon(iconName))
    element.classList.add('icon-button')
    element.setAttribute('aria-label', label)
    element.title = label
  }
  element.onclick = () => action(fn, 'interface', element)

  return element
}

function icon(name) {
  const paths = {
    // Google Material Icons/Symbols (Apache 2.0); see icons/MATERIAL-LICENSE.
    login:
      'M11,7L9.6,8.4l2.6,2.6H2v2h10.2l-2.6,2.6L11,17l5-5L11,7z M20,19h-8v2h8c1.1,0,2-0.9,2-2V5c0-1.1-0.9-2-2-2h-8v2h8V19z',
    recenter:
      'M440-40v-167l-44 43-56-56 140-140 140 140-56 56-44-43v167h-80ZM220-340l-56-56 43-44H40v-80h167l-43-44 56-56 140 140-140 140Zm520 0L600-480l140-140 56 56-43 44h167v80H753l43 44-56 56Zm-260-80q-25 0-42.5-17.5T420-480q0-25 17.5-42.5T480-540q25 0 42.5 17.5T540-480q0 25-17.5 42.5T480-420Zm0-180L340-740l56-56 44 43v-167h80v167l44-43 56 56-140 140Z',
    edit: 'M14.06 9.02l.92.92L5.92 19H5v-.92l9.06-9.06M17.66 3c-.25 0-.51.1-.7.29l-1.83 1.83 3.75 3.75 1.83-1.83c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.2-.2-.45-.29-.71-.29zm-3.6 3.19L3 17.25V21h3.75L17.81 9.94l-3.75-3.75z',
    more_horiz:
      'M6 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm12 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
    drag_indicator:
      'M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6C7.9 4 7 4.9 7 6s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
    settings:
      'M19.43 12.98c.04-.32.07-.64.07-.98 0-.34-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.09-.16-.26-.25-.44-.25-.06 0-.12.01-.17.03l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.06-.02-.12-.03-.18-.03-.17 0-.34.09-.43.25l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98 0 .33.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.09.16.26.25.44.25.06 0 .12-.01.17-.03l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.06.02.12.03.18.03.17 0 .34-.09.43-.25l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zm-1.98-1.71c.04.31.05.52.05.73 0 .21-.02.43-.05.73l-.14 1.13.89.7 1.08.84-.7 1.21-1.27-.51-1.04-.42-.9.68c-.43.32-.84.56-1.25.73l-1.06.43-.16 1.13-.2 1.35h-1.4l-.19-1.35-.16-1.13-1.06-.43c-.43-.18-.83-.41-1.23-.71l-.91-.7-1.06.43-1.27.51-.7-1.21 1.08-.84.89-.7-.14-1.13c-.03-.31-.05-.54-.05-.74s.02-.43.05-.73l.14-1.13-.89-.7-1.08-.84.7-1.21 1.27.51 1.04.42.9-.68c.43-.32.84-.56 1.25-.73l1.06-.43.16-1.13.2-1.35h1.39l.19 1.35.16 1.13 1.06.43c.43.18.83.41 1.23.71l.91.7 1.06-.43 1.27-.51.7 1.21-1.07.85-.89.7.14 1.13zM12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm0 6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z',
    check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z'
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.classList.add('icon')
  svg.setAttribute('viewBox', name === 'recenter' ? '0 -960 960 960' : '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('fill', 'currentColor')
  const path = document.createElementNS(svg.namespaceURI, 'path')
  path.setAttribute('d', paths[name])
  svg.append(path)
  return svg
}

function edit(p = {}) {
  const form = $('#profile-form')
  form.reset()
  form.elements.id.value = p.id || ''

  for (const [key, value] of Object.entries(p)) {
    if (form.elements.namedItem(key)) {
      form.elements.namedItem(key).value = Array.isArray(value) ? value.join(', ') : value
    }
  }

  form.elements.password.type = 'password'
  const toggle = form.querySelector('.password-toggle')
  toggle.dataset.i18n = 'showPassword'
  toggle.textContent = t('showPassword')
  toggle.setAttribute('aria-pressed', 'false')
  $('.profile-advanced').open = false
  $('#editor').showModal()
  syncKnock()
  form.elements.name.focus()
}

async function openSettings(scenario = '') {
  const url = api.runtime.getURL('options.html')
  const currentWindow = await api.windows?.getCurrent()
  const view = api.extension
    .getViews({ type: 'tab', ...(currentWindow ? { windowId: currentWindow.id } : {}) })
    .find(view => view.location.href.split(/[?#]/)[0] === url)
  if (view) {
    const tab = await (view.browser || view.chrome).tabs.getCurrent()
    await api.tabs.update(tab.id, {
      active: true,
      ...(scenario ? { url: `${url}#${scenario}` } : {})
    })
  } else {
    const tab = await api.tabs.create({ url: scenario ? `${url}#${scenario}` : url, active: true })
    await api.tabs.update(tab.id, { active: true })
  }
  if (api.tabs.getCurrent && !(await api.tabs.getCurrent())) {
    window.close()
  }
}

function openSettingsScenario() {
  const scenario = location.hash
  if (!['#add-profile', '#import-config'].includes(scenario)) {
    return
  }
  document.body.hidden = false
  history.replaceState(null, '', location.pathname + location.search)
  if (scenario === '#add-profile') {
    if (!$('#editor').open) {
      edit({ color: state.profiles.length % MegaProxy.colors.length })
    }
  } else {
    $('#import-start').showModal()
  }
}

function renderConfigSubscriptionStatus() {
  $('#config-subscription-status').hidden = !state.subscription
  if (!state.subscription) {
    return
  }
  const status = state.configSubscriptionState
  $('#config-subscription-status').textContent = status?.error
    ? MegaErrors.format(
        { message: status.error, errorDetails: status.errorDetails },
        'updateConfigSubscription',
        t
      )
    : status?.lastUpdated
      ? t('configSubscriptionUpdated', new Date(status.lastUpdated).toLocaleString())
      : ''
  $('#config-subscription-status').textContent +=
    ' ' +
    [
      !status?.error && status?.sourceIndex > 0
        ? t('configSubscriptionFallback', String(status.sourceIndex))
        : '',
      status?.skipped?.length ? t('importSkipped', status.skipped.join(', ')) : '',
      status?.skippedMasque ? t('masqueImportDisabled') : '',
      status?.unknownFields ? t('unknownConfigFields') : '',
      status?.unsupportedSplitProxy ? t('splitUnsupportedWarning') : '',
      status?.unsupportedWebRTC ? t('errorWebRTCUnsupported') : ''
    ]
      .filter(Boolean)
      .join(' ')
  $('#config-subscription-status').classList.toggle('error', Boolean(status?.error))
}

function render() {
  if (draggingProfile) {
    return
  }

  MegaI18n.apply(state.language || 'auto')
  const connectionNotice = $('#connection-update')
  const newConnectionNotice = connectionNotice.hidden && state.connectionUpdate
  connectionNotice.hidden = !state.connectionUpdate
  if (newConnectionNotice) {
    highlightAttention(connectionNotice)
  }
  $('#connection-update-message').textContent = state.connectionUpdate
    ? t(state.connectionUpdate.message)
    : ''
  $('#update-config-subscription').hidden = !state.subscription
  $('#config-subscription').hidden = !state.subscription
  renderConfigSubscriptionStatus()
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
    const subscriptionKey = JSON.stringify(state.subscription)
    if (state.subscription && subscriptionKey !== renderedSubscription) {
      $('#config-subscription-url').value = state.subscription.url
      $('#config-subscription-fallbacks').value = (state.subscription.fallbackUrls || []).join('\n')
      $('#config-subscription-username').value = state.subscription.username || ''
      $('#config-subscription-password').value = state.subscription.password || ''
      $('#config-subscription-enabled').checked = state.subscription.enabled
      $('#config-subscription-interval').value = state.subscription.intervalMinutes
    }
    renderedSubscription = subscriptionKey
    $('#webrtc').value = state.webRTC || 'browser'

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
    $('#knock-refresh-setting').hidden = platform.id !== 'chromium'
    $('#knock-refresh-enabled').checked = state.knockRefreshEnabled !== false
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

  const focusedProfile = captureProfileFocus(document.activeElement)
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
    title.append(flag, `${flag.textContent ? ' ' : ''}${p.name || p.host}`)

    const endpoint = document.createElement('p')
    endpoint.textContent = `${p.type.toUpperCase()} · ${p.host}:${p.port}`
    endpoint.title = endpoint.textContent
    info.append(title, endpoint)

    const actions = document.createElement('div')
    actions.className = 'actions'
    const select = button(
      t(selected ? 'selectedProfile' : 'connect'),
      () => send('activate', { id: p.id }),
      'secondary',
      selected ? 'check' : 'login'
    )
    select.disabled = selected
    if (isOptions) {
      const editButton = button(t('edit'), () => edit(p), 'secondary', 'edit')
      const menu = document.createElement('details')
      menu.className = 'profile-menu'
      const summary = document.createElement('summary')
      summary.setAttribute('aria-label', `${t('profileActions')}: ${p.name || p.host}`)
      summary.title = t('profileActions')
      summary.append(icon('more_horiz'))
      const items = document.createElement('div')
      items.append(
        button(t('clone'), () =>
          send('clone', { id: p.id, name: t('copyName', p.name || p.host) })
        ),
        button(
          t('delete'),
          () => {
            if (window.confirm(t('deleteProfileConfirm', p.name || p.host))) {
              return send('delete', { id: p.id })
            }
          },
          'danger'
        )
      )
      menu.append(summary, items)
      actions.append(...(selected ? [select, editButton, menu] : [editButton, select, menu]))
    } else {
      actions.append(select)
    }

    if (p.knockHost && selected) {
      const knock = button(
        t('knock'),
        async () => {
          $('#notice').textContent = t('working')
          $('#notice').textContent = t((await send('knock')).message)
        },
        'secondary',
        'recenter'
      )
      knock.disabled = !platform.needsKnock(p, true)
      actions.insertBefore(knock, select)
      actions.insertBefore(select, actions.querySelector('.profile-menu'))
    }

    if (isOptions) {
      card.append(profileDragHandle(card, p))
    }
    card.append(info, actions)
    $('#profiles').append(card)
  }

  restoreProfileFocus(focusedProfile)

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
  handle.append(icon('drag_indicator'))
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
  $('#rule-tab-url').disabled = !platform.supportsTabRouting || !tabs
  $('#rule-tab-url').closest('label').hidden = $('#rule-tab-url').disabled
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
  const notice = placeNotice($('#routing-form'))
  notice.closest('details, section')?.classList.remove('needs-attention')
  notice.textContent = t('saving')
  notice.classList.remove('error')
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
      notice.textContent = t('saved')
      notice.className = ''
    } catch (error) {
      notice.textContent = MegaErrors.format(error, 'interface', t)
      notice.className = 'error'
      highlightAttention(notice.closest('details, section') || notice)
    } finally {
      routingSaving = false
    }
  })
  return routingSaves
}

function savePreference(command, message) {
  const notice = placeNotice($('#connection-mode'))
  notice.textContent = t('saving')
  notice.classList.remove('error')
  routingSaves = routingSaves
    .then(async () => {
      await send(command, message)
      notice.textContent = t('saved')
      notice.className = ''
    })
    .catch(error => {
      notice.textContent = MegaErrors.format(error, 'interface', t)
      notice.className = 'error'
      highlightAttention(notice.closest('details, section') || notice)
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

async function reviewImport(data, subscription) {
  const preview = await send('previewImport', { data })
  pendingImport = data
  pendingSubscription = subscription
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
  highlightAttention($('#import-review'))
  $('#apply-import').focus()
  $('#import-review').scrollIntoView({ block: 'start' })
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
  $('#color-preview').style.backgroundColor = MegaProxy.colors[Number(form.elements.color.value)]
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
  form.querySelector('.password-toggle').disabled = form.elements.password.disabled
  $('#socks-auth-hint').hidden = !socksWithoutAuth
  $('#knock-hint').textContent = t(
    masque
      ? 'knockMasqueHint'
      : form.elements.type.value === 'socks5'
        ? 'knockSocksHint'
        : platform.id === 'chromium'
          ? 'knockChromiumHint'
          : 'knockHint'
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
  const flag = document.createElement('span')
  flag.className = 'country-flag'
  flag.textContent = /^[A-Z]{2}$/.test(code || '')
    ? [...code].map(c => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join('')
    : ''
  return flag
}

function renderCheck() {
  if (!state) {
    return
  }

  $('#check').disabled = busy
  const check = connectionCheck
  const flag = countryFlag(check?.countryCode)
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
            `${flag.textContent} ${check.countryCode || '—'}${countryName ? ` (${countryName})` : ''}`.trim(),
            check.latencyMs
          ),
          [check.httpProtocol?.toUpperCase(), check.tlsVersion].filter(Boolean).join(' · ')
        ]
          .filter(Boolean)
          .join('\n')
      : check.stage === 'failed'
        ? MegaErrors.format({ message: check.error, errorDetails: check.errorDetails }, 'check', t)
        : t(`checkStage_${check.stage}`)
  if (check?.stage === 'complete' && flag.textContent) {
    const result = $('#check-result')
    const text = result.textContent
    const index = text.lastIndexOf(flag.textContent)
    result.replaceChildren(text.slice(0, index), flag, text.slice(index + flag.textContent.length))
  }
  const result = $('#check-result')
  const attention = check?.errorDetails?.hint ? `${check.profileId}:${check.errorDetails.hint}` : ''
  if (attention && result.dataset.attention !== attention) {
    highlightAttention(result)
  } else if (!attention) {
    result.classList.remove('needs-attention')
  }
  result.dataset.attention = attention
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
  for (const option of [...$('#webrtc').options]) {
    if (!platform.supportsWebRTC(option.value)) {
      option.remove()
    }
  }
  if (!platform.supportsTabRouting) {
    $('#routing-mode option[value="tabs"]').remove()
  }
  $('#network-hint').dataset.i18n = platform.supportsTabRouting
    ? 'networkHint'
    : 'networkDomainsHint'
  if (platform.defaultTheme !== 'system') {
    $('#theme option[value=system]').remove()
  }
  for (const scheme of ['light', 'dark']) {
    matchMedia(`(prefers-color-scheme: ${scheme})`).addEventListener('change', renderThemeHint)
  }
  $('#cancel-profile').onclick = () => $('#editor').close()
  $('#editor').addEventListener('close', () => {
    if (document.activeElement !== document.body && document.activeElement !== $('#new')) {
      return
    }
    const id = $('#profile-form').elements.id.value
    const trigger = id ? $(`[data-profile-id="${CSS.escape(id)}"] .actions button`) : $('#new')
    trigger?.focus()
  })
  $('#open-url-import').onclick = () => $('#url-import').showModal()
  $('#cancel-url-import').onclick = () => $('#url-import').close()
  $('#build-version').textContent = globalThis.MegaBuild
    ? `MegaProxy ${globalThis.MegaBuild.version} · ${globalThis.MegaBuild.commit}`
    : ''
  $('#update-lists').onclick = () => action(() => send('updateSubscriptions'))
  $('#routing-settings').addEventListener('toggle', () => {
    if ($('#routing-settings').open) {
      send('routingOpened').catch(error => {
        placeNotice($('#routing-settings')).textContent = MegaErrors.format(
          error,
          'routingOpened',
          t
        )
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
    action(
      async () => {
        const url = $('#config-url').value
        const username = $('#config-username').value
        const password = $('#config-password').value
        const auth = username || password ? { username, password } : undefined
        const subscription = $('#config-follow').checked
          ? MegaProxy.subscription({ url, ...auth })
          : undefined
        let download
        try {
          download = await send('fetchConfig', { url, auth: subscription || auth })
        } catch (error) {
          const info = MegaErrors.details(error, 'fetchConfig')
          if (
            info.status ||
            !['TimeoutError', 'AbortError', 'errorNetwork'].includes(info.reason) ||
            !MegaProxy.routed(url, state) ||
            !window.confirm(t('configDownloadWithoutProxyConfirm'))
          ) {
            throw error
          }
          download = await send('fetchConfig', {
            url,
            auth: subscription || auth,
            withoutProxy: true
          })
        }
        const data = download.data
        await reviewImport(data, subscription)
        $('#import-summary').textContent =
          t('configDownloadChecked') + ' ' + $('#import-summary').textContent
        $('#config-password').value = ''
        $('#url-import').close()
        $('#apply-import').focus()
        $('#import-review').scrollIntoView({ block: 'start' })
      },
      'fetchConfig',
      event.submitter || event.target
    )
  }
  $('#config-subscription-form').onsubmit = event => {
    event.preventDefault()
    action(
      async () => {
        const subscription = MegaProxy.subscription({
          ...state.subscription,
          url: $('#config-subscription-url').value,
          fallbackUrls: $('#config-subscription-fallbacks').value.split(/\s+/).filter(Boolean),
          username: $('#config-subscription-username').value,
          password: $('#config-subscription-password').value,
          enabled: $('#config-subscription-enabled').checked,
          intervalMinutes: Number($('#config-subscription-interval').value)
        })
        await send('configSubscription', { subscription })
        $('#notice').textContent = t('saved')
      },
      'configSubscription',
      event.submitter || event.target
    )
  }
  $('#cancel-config-subscription').onclick = () =>
    action(async () => {
      await send('configSubscription', { subscription: null })
      $('#config-subscription').open = false
      placeNotice($('#open-url-import')).textContent = t('configSubscriptionCancelled')
      $('#open-url-import').focus()
    }, 'configSubscription')
  $('#clear-service-history').onchange = () =>
    action(async () => {
      const method = $('#clear-service-history').checked ? 'request' : 'remove'
      try {
        await api.permissions[method]({ permissions: ['history'] })
      } finally {
        await refreshServiceHistoryPermission()
      }
    })
  $('#connection-notifications').onchange = () =>
    action(async () => {
      if ($('#connection-notifications').checked) {
        await api.permissions.request({ permissions: ['notifications'] })
      } else {
        await api.permissions.remove({ permissions: ['notifications'] })
      }
      await refreshNotificationPermission()
    })
  $('#new').onclick = () => edit({ color: state.profiles.length % MegaProxy.colors.length })
  $('#profile-form').addEventListener('input', syncKnock)
  $('#statistics-enabled').onchange = () =>
    action(async () => {
      await send('statistics', { enabled: $('#statistics-enabled').checked })
      await send('get')
    })
  $('#bypass-local').onchange = () =>
    action(() => send('bypassLocalNetworks', { enabled: $('#bypass-local').checked }))
  $('#knock-refresh-enabled').onchange = () =>
    action(() => send('knockRefresh', { enabled: $('#knock-refresh-enabled').checked }))
  $('#theme').onchange = () => action(() => send('theme', { theme: $('#theme').value }))
  $('#language').onchange = () => action(() => send('language', { language: $('#language').value }))

  $('#profile-form').onsubmit = event => {
    event.preventDefault()
    action(async () => {
      const profile = Object.fromEntries(new FormData(event.target))
      profile.id ||= crypto.randomUUID()
      if (profile.type === 'masque' || (platform.id === 'chromium' && profile.type === 'socks5')) {
        profile.username = ''
        profile.password = ''
      }
      const previous = state.profiles.find(p => p.id === profile.id)
      const result = await send('save', { profile })
      const saved = result.state.profiles.find(p => p.id === profile.id)
      $('#profile-form').elements.id.value = saved?.id || ''
      $('#editor').close()
      if (
        platform.id === 'chromium' &&
        previous &&
        saved &&
        (previous.username !== saved.username || previous.password !== saved.password)
      ) {
        placeNotice($('#profiles')).textContent = t('credentialsRestartChromium')
      }
    })
  }

  $('#open-import').onclick = () => $('#import-start').showModal()
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
    action(
      async () => {
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
      },
      'previewImport',
      $('#import')
    )
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

      const result = await send('import', {
        data: pendingImport,
        removeIds,
        ...(pendingSubscription ? { subscription: pendingSubscription } : {})
      })
      placeNotice($('#open-import')).textContent = result.unsupportedSplitProxy
        ? t('splitUnsupportedWarning')
        : result.skipped?.length
          ? t('importSkipped', result.skipped.join(', '))
          : t('imported')
      $('#import-review').hidden = true
      pendingImport = null
      pendingSubscription = undefined
    }, 'import')
  $('#cancel-import').onclick = () => {
    $('#import-review').hidden = true
    pendingImport = null
    pendingSubscription = undefined
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
  $('#open-settings').onclick = () =>
    action(() => openSettings(), 'get', $('#open-settings'), false)
  for (const id of ['add-profile', 'import-config']) {
    $(`#${id}`).onclick = () => action(() => openSettings(id), 'get', $(`#${id}`), false)
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

$('#dismiss-connection-update').onclick = () => action(() => send('dismissConnectionUpdate'))
$('#update-config-subscription').onclick = () => action(() => send('updateConfigSubscription'))

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
    await refreshNotificationPermission()
    await refreshServiceHistoryPermission()
    window.addEventListener('focus', refreshPrivateAccess)
    window.addEventListener('focus', refreshNotificationPermission)
    window.addEventListener('focus', refreshServiceHistoryPermission)
    openSettingsScenario()
    window.addEventListener('hashchange', openSettingsScenario)
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
