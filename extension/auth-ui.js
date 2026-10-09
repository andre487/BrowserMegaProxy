/* global chrome, MegaErrors, MegaI18n, MegaPlatform, MEGA_TARGET */
const api = globalThis.browser || chrome
const token = new URL(location.href).searchParams.get('id')
const t = MegaI18n.t
const form = document.querySelector('#auth-form')
const username = document.querySelector('#auth-username')
const password = document.querySelector('#auth-password')
const notice = document.querySelector('#notice')
const cancel = document.querySelector('#auth-cancel')
const submit = document.querySelector('#auth-submit')
let phase
let submitting = false
let submissionError

async function send(command, extra = {}) {
  const response = await api.runtime.sendMessage({ command, token, ...extra })
  if (!response?.ok) {
    const error = new Error(response?.error || 'errorBackground')
    error.errorDetails = response?.errorDetails
    throw error
  }
  return response.auth
}

function showError(error, operation = 'authentication') {
  notice.textContent = MegaErrors.format(error, operation, t)
  notice.className = 'error'
}

function render(auth) {
  if (phase !== auth.phase) {
    submissionError = undefined
  }
  MegaI18n.apply(auth.language)
  const platform = MegaPlatform.create(MEGA_TARGET, api)
  const theme = platform.themePreference(auth.theme)
  document.documentElement.dataset.theme = theme === 'system' ? '' : theme
  document.querySelector('#auth-profile').textContent = auth.name
  document.querySelector('#auth-endpoint').textContent = `${auth.host}:${auth.port}`
  if (!phase) {
    username.value = auth.username || ''
  }
  const editable = ['waiting', 'rejected'].includes(auth.phase)
  username.disabled = password.disabled = submit.disabled = !editable || submitting
  const error = submissionError || auth.errorDetails
  notice.className = error ? 'error' : ''
  notice.textContent = error
    ? MegaErrors.format(error, 'authentication', t)
    : ['checking', 'saving'].includes(auth.phase)
      ? t('authChecking')
      : auth.phase === 'saved'
        ? t('authSaved')
        : ''
  document.querySelector('#auth-retry-hint').hidden =
    auth.phase !== 'failed' || auth.errorDetails?.code !== 'errorAuthUnconfirmed'
  cancel.textContent = t(auth.phase === 'saved' ? 'close' : 'cancel')
  if (auth.phase === 'saved') {
    password.value = ''
  }
  document.body.hidden = false
  if (!phase || (['waiting', 'rejected'].includes(auth.phase) && phase !== auth.phase)) {
    const input = username.value ? password : username
    input.focus()
    if (auth.phase === 'rejected') {
      input.select()
    }
  }
  phase = auth.phase
}

async function refresh() {
  if (submitting) {
    return
  }
  try {
    render(await send('authGet'))
  } catch (error) {
    document.body.hidden = false
    username.disabled = password.disabled = submit.disabled = true
    showError(error)
  }
}

form.onsubmit = async event => {
  event.preventDefault()
  if (submitting) {
    return
  }
  const credentials = { username: username.value, password: password.value }
  submissionError = undefined
  submitting = true
  submit.disabled = true
  try {
    await send('authSubmit', credentials)
  } catch (error) {
    submissionError = error
  } finally {
    submitting = false
  }
  await refresh()
}
cancel.onclick = async () => {
  try {
    await send('authCancel')
  } catch {
    // An expired request should still allow its dialog to close.
  } finally {
    const tab = await api.tabs.getCurrent()
    await api.tabs.remove(tab.id)
  }
}
Promise.resolve(MegaI18n.ready)
  .then(async () => {
    await refresh()
    // Keep an outstanding native auth callback alive while the user edits credentials.
    setInterval(refresh, 1000)
  })
  .catch(error => {
    document.body.hidden = false
    showError(error)
  })
