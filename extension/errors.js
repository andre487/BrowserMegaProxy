;(root => {
  const operations = new Set([
    'get',
    'currentSite',
    'network',
    'telemetry',
    'save',
    'activate',
    'connectionMode',
    'clone',
    'move',
    'delete',
    'routing',
    'routingOpened',
    'updateSubscriptions',
    'fetchConfig',
    'previewImport',
    'import',
    'export',
    'sync',
    'check',
    'knock',
    'webRTC',
    'theme',
    'language',
    'statistics',
    'bypassLocalNetworks',
    'testRule',
    'addCurrentSite',
    'excludeCurrentSite',
    'toggleTab',
    'clearNetwork',
    'addFailedDomains',
    'startup',
    'toolbarIcon',
    'locale',
    'interface',
    'logRead',
    'logClear',
    'logExport',
    'logConfigure',
    'authentication',
    'request'
  ])
  const resources = new Set([
    'toolbar16.png',
    'toolbar24.png',
    'toolbar32.png',
    'toolbar48.png',
    'toolbar64.png',
    'locale_en',
    'locale_ru'
  ])
  const codePattern =
    /^(?:splitUnsupportedWarning|error[A-Z][A-Za-z]+|(?:NS_ERROR_|SEC_ERROR_|SSL_ERROR_|MOZILLA_PKIX_ERROR_)[A-Z0-9_]+|(?:net::)?ERR_[A-Z0-9_]+)$/
  const names = new Set([
    'AbortError',
    'TimeoutError',
    'QuotaExceededError',
    'SecurityError',
    'NotAllowedError',
    'InvalidStateError',
    'NotFoundError',
    'UnknownError',
    'DataError',
    'SyntaxError',
    'TypeError'
  ])

  // Only controlled codes cross the UI/log boundary; native messages can contain credentials or URLs.
  function details(error, operation = 'interface') {
    const supplied = error?.errorDetails || error
    const message = error?.message || error?.error || ''
    const network =
      /^(?:Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed)$/i.test(
        message
      )
    const nativeReason = /(?:QUOTA_BYTES|MAX_WRITE_OPERATIONS|quota exceeded)/i.test(message)
      ? 'QuotaExceededError'
      : /(?:Receiving end does not exist|Extension context invalidated|message port closed|Could not establish connection)/i.test(
            message
          )
        ? 'errorBackground'
        : names.has(error?.name)
          ? error.name
          : undefined
    const result = {
      operation: operations.has(supplied?.operation)
        ? supplied.operation
        : operations.has(operation)
          ? operation
          : 'interface',
      code:
        (supplied?.code || message).length <= 96 && codePattern.test(supplied?.code || message)
          ? supplied?.code || message
          : network
            ? 'errorNetwork'
            : nativeReason === 'errorBackground'
              ? 'errorBackground'
              : /^HTTP ?[45][0-9]{2}$/.test(message) || (supplied?.status >= 400 && !message)
                ? 'errorHTTP'
                : 'errorUnexpected'
    }
    const cause = error?.cause ? details(error.cause, result.operation) : null
    const reason =
      supplied?.reason || (network ? 'errorNetwork' : nativeReason || cause?.reason || cause?.code)
    if ((reason || '').length <= 96 && (codePattern.test(reason || '') || names.has(reason))) {
      if (reason !== result.code) {
        result.reason = reason
      }
    }
    const status = supplied?.status || cause?.status
    if (Number.isInteger(status) && status >= 100 && status <= 599) {
      result.status = status
    }
    const resource = supplied?.resource || cause?.resource
    if (resources.has(resource)) {
      result.resource = resource
    }
    return result
  }

  function context(error, operation) {
    const wrapped = new Error(error?.message || 'errorUnexpected', { cause: error })
    wrapped.errorDetails = details(error, operation)
    return wrapped
  }

  function format(error, operation, t) {
    const info = details(error, operation)
    const label = 'operation' + info.operation[0].toUpperCase() + info.operation.slice(1)
    const explain = code => {
      const key = 'reason' + code.replace(/^net::/, '')
      const translated = t(key)
      return translated === key ? t(code) : names.has(code) ? translated : `${translated} (${code})`
    }
    const reason = [
      explain(info.code),
      info.reason ? explain(info.reason) : '',
      info.status ? `HTTP ${info.status}` : ''
    ]
      .filter(Boolean)
      .join('; ')
    return `${t(label)}${info.resource ? ` (${info.resource})` : ''}: ${reason}`
  }

  root.MegaErrors = { details, context, format }
})(globalThis)
