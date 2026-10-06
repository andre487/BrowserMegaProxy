/* global chrome */
;(root => {
  const api = root.browser || chrome
  const catalogs = {}
  let language = 'en'

  function resolveLanguage(preference = 'auto') {
    if (preference === 'ru' || preference === 'en') {
      return preference
    }

    return /^ru(?:[-_]|$)/i.test(api.i18n.getUILanguage()) ? 'ru' : 'en'
  }

  function t(key, ...substitutions) {
    const message = catalogs[language]?.[key]?.message || catalogs.en?.[key]?.message || key

    return message.replace(/\$(\d+)/g, (match, index) => substitutions[Number(index) - 1] ?? '')
  }

  function apply(preference) {
    language = resolveLanguage(preference)
    document.documentElement.lang = language
    document.title = t('extensionName')

    for (const element of document.querySelectorAll('[data-i18n]')) {
      element.textContent = t(element.dataset.i18n)
    }

    for (const element of document.querySelectorAll('[data-i18n-placeholder]')) {
      element.placeholder = t(element.dataset.i18nPlaceholder)
    }
  }

  const ready = Promise.all(
    ['en', 'ru'].map(async locale => {
      const response = await fetch(api.runtime.getURL(`_locales/${locale}/messages.json`))
      if (!response.ok) {
        throw new Error(`Unable to load locale: ${locale}`)
      }

      catalogs[locale] = await response.json()
    })
  )

  root.MegaI18n = { ready, resolveLanguage, t, apply }
})(globalThis)
