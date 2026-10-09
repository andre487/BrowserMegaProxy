/* global MegaI18n */
document.addEventListener('click', event => {
  const toggle = event.target.closest('.password-toggle')
  if (!toggle) {
    return
  }
  const input = toggle.parentElement.querySelector('input')
  if (input.disabled) {
    return
  }
  const show = input.type === 'password'
  input.type = show ? 'text' : 'password'
  toggle.dataset.i18n = show ? 'hidePassword' : 'showPassword'
  toggle.textContent = MegaI18n.t(toggle.dataset.i18n)
  toggle.setAttribute('aria-pressed', String(show))
})
