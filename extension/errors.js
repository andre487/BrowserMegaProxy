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
    'configSubscription',
    'updateConfigSubscription',
    'dismissConnectionUpdate',
    'notification',
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
    'authGet',
    'authSubmit',
    'authCancel',
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
    /^(?:splitUnsupportedWarning|error[A-Z][A-Za-z]+|(?:NS_ERROR_|NS_BINDING_|NS_BASE_|PR_|SEC_ERROR_|SSL_ERROR_|MOZILLA_PKIX_ERROR_)[A-Z0-9_]+|(?:net::)?ERR_[A-Z0-9_]+)$/
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

  function responseText(value, secrets = []) {
    let text = String(value || '')
    const encodedSecrets = new Set(
      secrets
        .filter(value => typeof value === 'string' && value)
        .flatMap(secret => [
          secret,
          encodeURIComponent(secret),
          JSON.stringify(secret).slice(1, -1)
        ])
    )
    // Mark the original text: credentials may overlap or contain the replacement marker itself.
    const hidden = new Uint8Array(text.length)
    for (const secret of encodedSecrets) {
      for (
        let start = text.indexOf(secret);
        start !== -1;
        start = text.indexOf(secret, start + 1)
      ) {
        hidden.fill(1, start, start + secret.length)
      }
      // A bounded read can end partway through an echoed credential.
      for (let length = Math.min(secret.length - 1, text.length); length >= 4; length--) {
        if (text.endsWith(secret.slice(0, length))) {
          hidden.fill(1, text.length - length)
          break
        }
      }
    }
    text = Array.from(text.split(''), (character, index) =>
      hidden[index] ? (hidden[index - 1] ? '' : '[redacted]') : character
    ).join('')
    const safe = text
      .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL redacted]')
      .replace(/\b(?:Bearer|Basic|JWT)\s+[A-Za-z0-9._~+/=-]+/gi, '[authorization redacted]')
      .replace(
        /(["']?(?:password|username|sessionid|csrftoken|cookie|authorization|(?:access_|refresh_)?token|api[_-]?key|client_secret|secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"?|'[^'\r\n]*'?|[^\s,;<}]+)/gi,
        '$1[redacted]'
      )
      .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    return safe.length > 4096 ? safe.slice(0, 4084) + ' [truncated]' : safe
  }

  async function httpError(
    response,
    message = 'errorHTTP',
    secrets = [],
    { includeResponseBody = false } = {}
  ) {
    const error = Object.assign(new Error(message), { status: response.status })
    if (!includeResponseBody && (response.status < 500 || response.status > 599)) {
      return error
    }
    let reader
    try {
      let text = ''
      let bytes = 0
      let truncated = false
      reader = response.body?.getReader()
      if (reader) {
        const decoder = new TextDecoder()
        while (bytes < 16384) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }
          const part = value.subarray(0, 16384 - bytes)
          bytes += part.length
          text += decoder.decode(part, { stream: true })
        }
        text += decoder.decode()
        if (bytes === 16384) {
          truncated = true
        }
      } else {
        text = (await response.text()).slice(0, 16384)
      }
      error.responseBody = responseText(text, secrets) || '[empty response body]'
      if (truncated && !error.responseBody.endsWith('[truncated]')) {
        error.responseBody = error.responseBody.slice(0, 4084) + ' [truncated]'
      }
    } catch {
      error.responseBody = '[response body unavailable]'
    } finally {
      await reader?.cancel().catch(() => {})
    }
    if (!codePattern.test(message)) {
      error.message += `; response: ${error.responseBody}`
    }
    return error
  }

  // Keep native messages out of UI/logs; only controlled codes and sanitized 5xx excerpts cross this boundary.
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
    const responseBody = supplied?.responseBody || cause?.responseBody
    if (status >= 500 && status <= 599 && typeof responseBody === 'string') {
      result.responseBody = responseText(responseBody)
    }
    const resource = supplied?.resource || cause?.resource
    if (resources.has(resource)) {
      result.resource = resource
    }
    if ((supplied?.hint || cause?.hint) === 'errorKnockMayBeRequired') {
      result.hint = 'errorKnockMayBeRequired'
    }
    return result
  }

  function proxyFailure(error, profile, operation = 'request') {
    const info = details(error, operation)
    // ponytail: transport errors only suggest camouflage; a definite diagnosis needs a server signal.
    if (
      ['http', 'https'].includes(profile?.type) &&
      !profile.knockHost &&
      !info.status &&
      [info.code, info.reason].some(code =>
        [
          'errorCheckTimeout',
          'TimeoutError',
          'net::ERR_TUNNEL_CONNECTION_FAILED',
          'net::ERR_TIMED_OUT',
          'net::ERR_CONNECTION_TIMED_OUT',
          'NS_ERROR_PROXY_BAD_GATEWAY',
          'NS_ERROR_NET_TIMEOUT'
        ].includes(code)
      )
    ) {
      info.hint = 'errorKnockMayBeRequired'
    }
    const wrapped = context(error, operation)
    wrapped.errorDetails = info
    return wrapped
  }

  function isNavigationCancellation(error, target) {
    return (
      target === 'firefox' &&
      ['NS_BINDING_ABORTED', 'NS_ERROR_DOCUMENT_LOAD_LISTENER_NO_PARENT_CHANNEL'].includes(error)
    )
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
      info.status ? `HTTP ${info.status}` : '',
      info.responseBody || ''
    ]
      .filter(Boolean)
      .join('; ')
    return `${t(label)}${info.resource ? ` (${info.resource})` : ''}: ${reason}${info.hint ? `\n${t(info.hint)}` : ''}`
  }

  root.MegaErrors = {
    details,
    context,
    format,
    httpError,
    responseText,
    proxyFailure,
    isNavigationCancellation
  }
})(globalThis)
