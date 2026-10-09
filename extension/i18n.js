/* global chrome, MegaErrors */
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
    const message =
      catalogs[language]?.[key]?.message ||
      catalogs.en?.[key]?.message ||
      api.i18n.getMessage?.(key) ||
      key

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
      try {
        const response = await fetch(api.runtime.getURL(`_locales/${locale}/messages.json`))
        if (!response.ok) {
          throw await MegaErrors.httpError(response)
        }

        catalogs[locale] = await response.json()
      } catch (error) {
        throw MegaErrors.context(
          Object.assign(new Error('errorLocale', { cause: error }), {
            resource: `locale_${locale}`
          }),
          'locale'
        )
      }
    })
  )

  root.MegaI18n = { ready, resolveLanguage, t, apply }
})(globalThis)
