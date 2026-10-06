/* Shared configuration and routing logic. Credentials only reach the matching proxy. */
;(root => {
  const hasCredentials = p => Boolean(p?.username && p?.password)

  const platform = root.MegaPlatform.create(root.MEGA_TARGET, undefined, {
    hasCredentials,
    chromiumImplicitHost
  })
  const SCHEMA = 'net.megaproxy487.config'
  const patternCache = new WeakMap()
  const colors = [
    '#f44336',
    '#e91e63',
    '#9c27b0',
    '#673ab7',
    '#3f51b5',
    '#2196f3',
    '#009688',
    '#4caf50',
    '#8bc34a',
    '#ff9800',
    '#ff5722',
    '#795548'
  ]
  const localRanges = [
    '127.0.0.0/8',
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '169.254.0.0/16',
    '::1/128',
    'fc00::/7',
    'fe80::/10'
  ]
  const defaults = () => ({
    profiles: [],
    activeId: null,
    theme: 'system',
    language: 'auto',
    statisticsEnabled: true,
    connectionMode: 'proxy',
    webRTC: 'browser',
    bypassLocalNetworks: true,
    browserRouting: routing()
  })

  function host(value) {
    const text = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '')
    if (!text || text.length > 253 || /[\s/@?#\\]/.test(text)) {
      throw new Error('errorHost')
    }

    let url
    try {
      url = new URL(`https://${text.includes(':') ? `[${text}]` : text}`)
    } catch {
      throw new Error('errorHost')
    }

    if (url.port || url.pathname !== '/') {
      throw new Error('errorHostPort')
    }

    return url.hostname.replace(/^\[|\]$/g, '')
  }

  function domainPattern(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 253) {
      throw new Error('errorRoutingPattern')
    }

    const text = value.trim().toLowerCase().replace(/\.$/, '')
    if (!text.includes('*')) {
      return host(text)
    }

    if (
      !/^[a-z0-9*](?:[a-z0-9.*-]*[a-z0-9*])?$/.test(text) ||
      text.includes('..') ||
      text
        .split('.')
        .some(label => label.length > 63 || label.startsWith('-') || label.endsWith('-'))
    ) {
      throw new Error('errorRoutingPattern')
    }

    return text
  }

  function routing(input = {}) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      (input.enabled !== undefined && typeof input.enabled !== 'boolean') ||
      (input.mode !== undefined && !['domains', 'tabs'].includes(input.mode)) ||
      (input.strategy !== undefined &&
        !['manual', 'lists', 'profiles', 'tabs', 'failover'].includes(input.strategy))
    ) {
      throw new Error('errorProfileFields')
    }

    const lists = {}
    for (const key of ['domains', 'sites']) {
      const values = input[key] ?? []
      if (!Array.isArray(values) || values.length > 1000) {
        throw new Error('errorProfileFields')
      }

      lists[key] = [...new Set(values.map(domainPattern))]
    }

    const assignments = input.assignments ?? []
    if (
      !Array.isArray(assignments) ||
      assignments.length > 1000 ||
      assignments.some(a => !a || typeof a.profileId !== 'string' || !a.profileId.trim())
    ) {
      throw new Error('errorProfileFields')
    }

    if (
      assignments.some(
        a => a.includeSubdomains !== undefined && typeof a.includeSubdomains !== 'boolean'
      )
    ) {
      throw new Error('errorProfileFields')
    }

    const normalized = assignments.map(a => ({
      domain: host(a.domain),
      profileId: a.profileId,
      ...(a.includeSubdomains === false ? { includeSubdomains: false } : {})
    }))
    if (normalized.some(a => a.domain.includes(':'))) {
      throw new Error('errorRoutingPattern')
    }

    if (new Set(normalized.map(a => a.domain)).size !== normalized.length) {
      throw new Error('errorProfileFields')
    }

    const subscriptions = root.MegaSubscriptions?.options(input.subscriptions) || {
      domainSources: [],
      siteSources: [],
      autoUpdate: true,
      throughProxy: false
    }
    return {
      enabled: input.strategy === 'failover' ? false : (input.enabled ?? false),
      mode: input.strategy
        ? input.strategy === 'tabs'
          ? 'tabs'
          : 'domains'
        : input.mode || 'domains',
      ...(input.strategy
        ? {
            strategy: ['profiles', 'failover'].includes(input.strategy) ? 'manual' : input.strategy
          }
        : {}),
      ...lists,
      assignments: [],
      subscriptions
    }
  }

  function routingStrategy(config) {
    return !config.enabled
      ? 'all'
      : config.strategy ||
          (config.mode === 'tabs'
            ? 'tabs'
            : config.subscriptions.domainSources.length && !config.domains.length
              ? 'lists'
              : 'manual')
  }

  function matchesDomain(hostname, patterns) {
    const h = hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '')

    return patterns.some(pattern => {
      if (pattern.startsWith('**.') && !pattern.slice(3).includes('*')) {
        return h === pattern.slice(3) || h.endsWith(`.${pattern.slice(3)}`)
      }

      const parts = pattern.split('*')
      if (parts.length === 1) {
        return h === pattern
      }

      const last = parts[parts.length - 1]
      if (!h.startsWith(parts[0]) || !h.endsWith(last)) {
        return false
      }

      let offset = parts[0].length
      const end = h.length - last.length
      for (const part of parts.slice(1, -1)) {
        const index = h.indexOf(part, offset)
        if (index < 0 || index + part.length > end) {
          return false
        }

        offset = index + part.length
      }

      return offset <= end
    })
  }

  function routingPatterns(state, mode) {
    const config = state.browserRouting || routing()
    let cached = patternCache.get(state)
    if (!cached || cached.config !== config || cached.snapshot !== state.subscriptionCache) {
      const key = root.MegaSubscriptions?.sourceKey(
        config.subscriptions || root.MegaSubscriptions.options()
      )
      const snapshot =
        key && state.subscriptionCache?.sourceKey === key ? state.subscriptionCache : {}
      cached = { config, snapshot: state.subscriptionCache }
      for (const name of ['domains', 'sites']) {
        const manual =
          !config.strategy || ['manual', 'tabs'].includes(config.strategy) ? config[name] : []
        const downloaded =
          !config.strategy || config.strategy === 'lists' ? snapshot[name] || [] : []
        cached[name] = [...new Set([...manual, ...downloaded])].slice(0, 1000)
      }

      patternCache.set(state, cached)
    }

    return cached[mode]
  }

  function chromiumImplicitHost(hostname) {
    const h = hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '')

    return (
      h === 'localhost' ||
      h.endsWith('.localhost') ||
      h === '::1' ||
      /^(?:127\.|169\.254\.|fe[89ab][0-9a-f]:)/.test(h) ||
      (h.startsWith('::ffff:') && localHost(h) && /^(?:::ffff:(?:7f|a9fe))/.test(h))
    )
  }

  function routed(url, state, tabUrl = '', override) {
    const p = routeProfile(url, state, tabUrl, override)
    const hostname = host(new URL(url).hostname)
    if (state.downloadRouting?.hosts.includes(hostname)) {
      return Boolean(p && state.downloadRouting.throughProxy)
    }

    if (!p || p.type === 'direct' || bypassed(hostname, p, state)) {
      return false
    }

    if (platform.implicitBypass(hostname, state)) {
      return false
    }

    if (
      (state.routingExtraDomains || []).includes(hostname) ||
      (p.knockHost === hostname && platform.needsKnock(p))
    ) {
      return true
    }

    const config = state.browserRouting || routing()
    if (!config.enabled) {
      return true
    }

    if (config.mode === 'domains') {
      return matchesDomain(hostname, routingPatterns(state, 'domains'))
    }

    if (override !== undefined) {
      return override
    }

    try {
      return routingPatterns(state, 'sites').some(pattern =>
        matchesDomain(new URL(tabUrl).hostname, [pattern.includes('*') ? pattern : `**.${pattern}`])
      )
    } catch {
      return false
    }
  }

  function routeProfile(url, state) {
    return active(state)
  }

  function profile(input) {
    const type = String(input.type || 'https').toLowerCase()
    if (!['https', 'http'].includes(type)) {
      throw new Error('errorProtocol')
    }

    const port = Number(input.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('errorPort')
    }

    const username = String(input.username || '')
    const password = String(input.password || '')
    if (
      /[:\r\n]/.test(username) ||
      /[\r\n]/.test(password) ||
      username.length > 4096 ||
      password.length > 16384
    ) {
      throw new Error('errorCredentials')
    }

    if (!username && password) {
      throw new Error('errorUsername')
    }

    if (input.allowInvalidProxyCertificate) {
      throw new Error('errorCertificate')
    }

    const bypass = [
      ...new Set(
        (Array.isArray(input.bypass) ? input.bypass : String(input.bypass || '').split(/[\s,]+/))
          .filter(Boolean)
          .map(host)
      )
    ]
    const knockHost = input.knockHost ? host(input.knockHost) : ''
    if (knockHost && bypass.some(h => knockHost === h || knockHost.endsWith(`.${h}`))) {
      throw new Error('errorKnockBypass')
    }

    const id = String(input.id || crypto.randomUUID())
    const name = String(input.name || '').trim()
    const color = Number(input.color || 0)
    const countryCode = String(input.countryCode || '').toUpperCase()
    if (
      id.length > 256 ||
      name.length > 256 ||
      !Number.isInteger(color) ||
      color < 0 ||
      color > 2147483647 ||
      !/^([A-Z]{2})?$/.test(countryCode) ||
      bypass.length > 1000
    ) {
      throw new Error('errorProfileFields')
    }

    return {
      id,
      name,
      color,
      countryCode,
      type,
      host: host(input.host),
      port,
      username,
      password,
      knockHost,
      bypass,
      authMode: input.authMode === 'challenge' ? 'challenge' : 'auto',
      ...(input.portable ? { portable: structuredClone(input.portable) } : {})
    }
  }

  const active = state =>
    !['direct', 'system'].includes(state.connectionMode) &&
    state.profiles.find(p => p.id === state.activeId)

  const needsKnock = (p, target = root.MEGA_TARGET) =>
    root.MegaPlatform.create(target).needsKnock(p)

  function localHost(hostname) {
    const h = hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '')
    if (
      h === 'localhost' ||
      h.endsWith('.localhost') ||
      h.endsWith('.local') ||
      (!h.includes('.') && !h.includes(':'))
    ) {
      return true
    }

    if (h.includes(':')) {
      if (h.startsWith('::ffff:')) {
        const parts = h.slice(7).split(':')
        if (parts.length === 2) {
          const number = parseInt(parts[0], 16) * 65536 + parseInt(parts[1], 16)
          return localHost(
            [number >>> 24, (number >>> 16) & 255, (number >>> 8) & 255, number & 255].join('.')
          )
        }
      }

      return h === '::1' || /^(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/.test(h)
    }

    const parts = h.split('.').map(Number)
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
      return false
    }

    return (
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254)
    )
  }

  function bypassed(hostname, p, state = {}) {
    const h = hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '')

    return (
      (state.bypassLocalNetworks !== false && localHost(h)) ||
      p.bypass.some(domain => h === domain || h.endsWith(`.${domain}`))
    )
  }

  function basic(p) {
    const bytes = new TextEncoder().encode(`${p.username}:${p.password}`)

    return `Basic ${btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''))}`
  }

  function proxyInfo(url, state, tabUrl = '', override) {
    const p = routeProfile(url, state, tabUrl, override)
    if (!routed(url, state, tabUrl, override)) {
      return { type: 'direct' }
    }

    return {
      type: p.type,
      host: p.host,
      port: p.port,
      ...(hasCredentials(p) ? { proxyAuthorizationHeader: basic(p) } : {})
    }
  }

  function auth(details, state, attempts) {
    const p = state.profiles.find(p => p.id === details.profileId) || active(state)
    if (
      !hasCredentials(p) ||
      !details.isProxy ||
      details.challenger?.host.toLowerCase().replace(/^\[|\]$/g, '') !== p.host ||
      Number(details.challenger.port) !== p.port
    ) {
      return {}
    }

    if (attempts.has(details.requestId)) {
      return { cancel: true }
    }

    attempts.add(details.requestId)

    return { authCredentials: { username: p.username, password: p.password } }
  }

  function chromiumConfig(p, state = {}) {
    if (state.browserRouting?.enabled || state.downloadRouting) {
      const proxyHost = p.host.includes(':') ? `[${p.host}]` : p.host
      const endpoint = `${p.type === 'https' ? 'HTTPS' : 'PROXY'} ${proxyHost}:${p.port}`
      const patterns = [
        ...routingPatterns(state, 'domains'),
        ...(state.routingExtraDomains || []),
        ...(p.knockHost ? [p.knockHost] : [])
      ]
      return {
        mode: 'pac_script',
        pacScript: {
          mandatory: true,
          data: `
${localHost.toString()}
${matchesDomain.toString()}
function FindProxyForURL(url, host) {
  host = host.toLowerCase().replace(/^\\[|\\]$/g, '').replace(/\\.$/, '');

  if (${JSON.stringify(state.downloadRouting?.hosts || [])}.indexOf(host) >= 0) {
    return ${JSON.stringify(state.downloadRouting?.throughProxy ? endpoint : 'DIRECT')};
  }

  if (${JSON.stringify(state.routingExtraDomains || [])}.indexOf(host) >= 0 || host === ${JSON.stringify(p.knockHost || '')}) {
    return ${JSON.stringify(endpoint)};
  }

  if (${state.bypassLocalNetworks !== false} && localHost(host)) {
    return 'DIRECT';
  }

  if (matchesDomain(host, ${JSON.stringify(p.bypass.flatMap(h => [h, `*.${h}`]))})) {
    return 'DIRECT';
  }

  return ${state.browserRouting?.enabled ? `matchesDomain(host, ${JSON.stringify(patterns)}) ? ${JSON.stringify(endpoint)} : 'DIRECT'` : JSON.stringify(endpoint)};
}`
        }
      }
    }

    return {
      mode: 'fixed_servers',
      rules: {
        singleProxy: { scheme: p.type, host: p.host, port: p.port },
        // Make disabling local bypass override Chromium's implicit loopback exclusion.
        bypassList: [
          '<-loopback>',
          ...(state.downloadRouting && !state.downloadRouting.throughProxy
            ? state.downloadRouting.hosts
            : []),
          ...(state.bypassLocalNetworks !== false
            ? [
                ...localRanges,
                '<local>',
                '*.localhost',
                '*.local',
                '[::ffff:127.0.0.0]/104',
                '[::ffff:10.0.0.0]/104',
                '[::ffff:172.16.0.0]/108',
                '[::ffff:192.168.0.0]/112',
                '[::ffff:169.254.0.0]/112'
              ]
            : []),
          ...p.bypass.flatMap(h => (h.includes(':') ? [`[${h}]`] : [h, `*.${h}`]))
        ]
      }
    }
  }

  function filterConfig(input) {
    const supported = {
      '': [
        'schema',
        'version',
        'passwordsIncluded',
        'privateKeysIncluded',
        'activeProfileId',
        'profiles',
        'routing',
        'browser'
      ],
      '/routing': ['bypassLocalNetworks'],
      '/browser': ['theme', 'language', 'routing', 'webRTC'],
      '/browser/routing': [
        'enabled',
        'mode',
        'strategy',
        'domains',
        'sites',
        'subscriptions',
        'assignments'
      ],
      '/browser/routing/assignments/*': ['domain', 'profileId', 'includeSubdomains'],
      '/browser/routing/subscriptions': [
        'domainSources',
        'siteSources',
        'autoUpdate',
        'throughProxy'
      ],
      '/profiles/*': ['id', 'name', 'color', 'countryCode', 'proxy', 'browser', 'routing'],
      '/profiles/*/proxy': ['type', 'host', 'port', 'username', 'password'],
      '/profiles/*/browser': ['knockHost', 'bypass', 'authMode'],
      '/profiles/*/routing': ['bypassLocalNetworks']
    }
    let unknownFields = false

    function project(value, path) {
      if (Array.isArray(value)) {
        return value.map(item => project(item, `${path}/*`))
      }

      if (!value || typeof value !== 'object') {
        return value
      }

      const result = {}
      for (const [key, child] of Object.entries(value)) {
        if (supported[path]?.includes(key)) {
          result[key] = project(child, `${path}/${key}`)
        } else {
          unknownFields = true
        }
      }

      return result
    }

    return { config: project(input, ''), unknownFields }
  }

  function importProfiles(input, target = root.MEGA_TARGET) {
    const client = root.MegaPlatform.create(target)
    let data = input
    if (typeof data === 'string') {
      const text = data.replace(/^\uFEFF/, '').trim()
      if (/^[{[]/.test(text)) {
        try {
          data = JSON.parse(text)
        } catch {
          throw new Error('errorJSON')
        }
      } else {
        const lines = text
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('#'))
        if (!lines.length || lines.length > 1000) {
          throw new Error('errorImport')
        }

        const profiles = []
        const skipped = []
        let unknownFields = false
        for (const line of lines) {
          let url
          try {
            url = new URL(line)
          } catch {
            throw new Error('errorImport')
          }

          if (!['https:', 'http:'].includes(url.protocol)) {
            skipped.push(url.protocol)
            continue
          }

          if (line.length > 65536 || !/^[a-z]+:\/\/[^/]*:[^/]*@/i.test(line)) {
            throw new Error('errorImport')
          }

          let username, password
          try {
            username = decodeURIComponent(url.username)
            password = decodeURIComponent(url.password)
          } catch {
            throw new Error('errorImport')
          }

          if ([...url.searchParams.keys()].some(key => !['title', 'cc'].includes(key))) {
            unknownFields = true
          }

          profiles.push(
            profile({
              name: url.searchParams.get('title'),
              countryCode: url.searchParams.get('cc'),
              type: url.protocol.slice(0, -1),
              host: url.hostname,
              port: url.port || (url.protocol === 'https:' ? 443 : 80),
              username,
              password,
              color: profiles.length
            })
          )
        }

        if (!profiles.length) {
          throw new Error('errorImportCompatible')
        }

        return { profiles, skipped, missingPasswords: [], unknownFields }
      }
    }

    if (
      data &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      !data.schema &&
      data.schemaVersion !== undefined &&
      Object.keys(data).some(key => key.startsWith('+'))
    ) {
      return importZeroOmega(data)
    }

    let entries = Array.isArray(data) ? data : data?.profiles || data?.data
    if (!Array.isArray(entries) || !entries.length || entries.length > 1000) {
      throw new Error('errorImport')
    }

    const portable = data?.schema === SCHEMA || data?.schema === 'dev.megaproxy.config'
    if (portable && data.version === 8 && root.MegaValidate && !root.MegaValidate(data)) {
      throw new Error('errorProfileFields')
    }

    if (data?.schema && !portable) {
      throw new Error('errorImport')
    }

    if (portable && (!Number.isInteger(data.version) || data.version < 1 || data.version > 8)) {
      throw new Error('errorConfigVersion')
    }

    if (
      portable &&
      data.browser &&
      (!['auto', 'ru', 'en'].includes(data.browser.language || 'auto') ||
        !['system', 'light', 'dark'].includes(data.browser.theme || 'system'))
    ) {
      throw new Error('errorProfileFields')
    }

    if (
      data?.routing?.bypassLocalNetworks !== undefined &&
      typeof data.routing.bypassLocalNetworks !== 'boolean'
    ) {
      throw new Error('errorProfileFields')
    }

    if (portable && data.version >= 7) {
      const ids = new Set(entries.map(entry => entry.id))
      if (ids.size !== entries.length) {
        throw new Error('errorDuplicateIds')
      }

      if (data.activeProfileId && !ids.has(data.activeProfileId)) {
        throw new Error('errorProfileMissing')
      }
    }

    const browserRouting =
      portable && data.browser?.routing !== undefined ? routing(data.browser.routing) : undefined
    const unsupportedSplitProxy = client.downgradeRouting(browserRouting)

    if (portable && data.browser?.webRTC !== undefined) {
      webRTC(data.browser.webRTC)
    }

    const unsupportedWebRTC = portable && !client.supportsWebRTC(data.browser?.webRTC)
    if (unsupportedWebRTC) {
      data = { ...data, browser: { ...data.browser, webRTC: 'browser' } }
    }

    let unknownFields =
      !portable &&
      !Array.isArray(data) &&
      Object.keys(data).some(key => !['profiles', 'data'].includes(key))
    const originalEntries = entries
    if (portable) {
      const filtered = filterConfig(data)
      data = filtered.config
      entries = data.profiles
      unknownFields =
        filtered.unknownFields ||
        Boolean(data.browser?.routing?.assignments?.length) ||
        data.browser?.routing?.strategy === 'profiles'
    }

    const profiles = []
    const skipped = []
    const missingPasswords = []
    const ids = new Set()
    for (const [index, entry] of entries.entries()) {
      if (!entry || typeof entry !== 'object') {
        throw new Error('errorImport')
      }

      const p = entry.proxy || entry
      if (!portable) {
        const fields = [
          'id',
          'name',
          'title',
          'color',
          'countryCode',
          'cc',
          'type',
          'proxyType',
          'host',
          'hostname',
          'address',
          'port',
          'username',
          'password',
          'knockHost',
          'bypass',
          'authMode'
        ]
        if (
          Object.keys(p).some(key => !fields.includes(key)) ||
          (entry.proxy &&
            Object.keys(entry).some(
              key =>
                ![
                  'name',
                  'title',
                  'color',
                  'countryCode',
                  'cc',
                  'id',
                  'proxy',
                  'knockHost'
                ].includes(key)
            ))
        ) {
          unknownFields = true
        }
      }

      const rawType = String(p.type || p.proxyType || '')
        .trim()
        .toLowerCase()
      const type = rawType === 'ssl' ? 'https' : rawType
      if (
        !['http', 'https'].includes(type) ||
        p.allowInvalidProxyCertificate ||
        originalEntries[index]?.proxy?.allowInvalidProxyCertificate
      ) {
        skipped.push(entry.name || entry.title || type)
        continue
      }

      if (p.pac || p.pacString) {
        skipped.push(entry.name || entry.title || type)
        continue
      }

      if (portable && data.version >= 7 && (typeof entry.id !== 'string' || !entry.id.trim())) {
        throw new Error('errorProfileFields')
      }

      const browser = entry.browser || {}
      if (
        (browser.bypass !== undefined &&
          (!Array.isArray(browser.bypass) || browser.bypass.some(h => typeof h !== 'string'))) ||
        (browser.knockHost !== undefined && typeof browser.knockHost !== 'string') ||
        (browser.authMode !== undefined && !['auto', 'challenge'].includes(browser.authMode))
      ) {
        throw new Error('errorProfileFields')
      }

      const hexColor = !portable && /^#[0-9a-f]{6}$/i.test(entry.color)
      const paletteIndex = hexColor ? colors.indexOf(entry.color.toLowerCase()) : -1
      const color = hexColor
        ? paletteIndex >= 0
          ? paletteIndex
          : profiles.length
        : (entry.color ?? profiles.length)
      const result = profile({
        ...p,
        id: portable ? entry.id || `import-${profiles.length}` : undefined,
        name: entry.name || entry.title,
        color,
        countryCode: entry.countryCode || entry.cc,
        type,
        port: p.port || (type === 'https' ? 443 : 80),
        host: p.host || p.hostname || p.address,
        knockHost: browser.knockHost ?? p.knockHost ?? entry.knockHost,
        bypass: browser.bypass ?? p.bypass ?? [],
        authMode: browser.authMode || p.authMode,
        ...(portable ? { portable: entry } : {})
      })
      if (ids.has(result.id)) {
        throw new Error('errorDuplicateIds')
      }

      ids.add(result.id)
      if (portable && !Object.hasOwn(p, 'password')) {
        missingPasswords.push(result.id)
      }

      profiles.push(result)
    }

    if (!profiles.length) {
      throw new Error('errorImportCompatible')
    }

    return {
      profiles,
      skipped,
      missingPasswords,
      unknownFields,
      ...(portable
        ? {
            config: structuredClone(data),
            unsupportedSplitProxy,
            unsupportedWebRTC,
            ...(browserRouting ? { browserRouting } : {}),
            bypassLocalNetworks: data.routing?.bypassLocalNetworks ?? true
          }
        : {})
    }
  }

  function importZeroOmega(data) {
    const entries = Object.entries(data).filter(([key]) => key.startsWith('+'))
    if (entries.length > 1000 || ![1, 2].includes(data.schemaVersion)) {
      throw new Error('errorImport')
    }

    const profiles = []
    const skipped = []
    const byName = new Map()
    let unknownFields = false
    for (const [key, entry] of entries) {
      if (!entry || typeof entry !== 'object') {
        throw new Error('errorImport')
      }

      const name = entry.name || key.slice(1)
      if (entry.profileType !== 'FixedProfile') {
        if (
          !['SwitchProfile', 'DirectProfile', 'SystemProfile', 'VirtualProfile'].includes(
            entry.profileType
          )
        ) {
          skipped.push(name)
        }

        continue
      }

      const endpoints = ['proxyForHttp', 'proxyForHttps', 'proxyForFtp', 'fallbackProxy']
        .filter(key => entry[key])
        .map(key => [key, entry[key]])
      if (!endpoints.length) {
        skipped.push(name)
        continue
      }

      const [endpointKey, endpoint] = endpoints[0]
      if (
        !['http', 'https'].includes(endpoint.scheme) ||
        endpoints.some(
          ([, p]) =>
            p.scheme !== endpoint.scheme || p.host !== endpoint.host || p.port !== endpoint.port
        )
      ) {
        skipped.push(name)
        continue
      }

      if (!entry.fallbackProxy || entry.proxyForFtp) {
        unknownFields = true
      }

      const credentials = entry.auth?.[endpointKey] || entry.auth?.all || {}
      if (
        endpoints.some(
          ([key]) =>
            JSON.stringify(entry.auth?.[key] || entry.auth?.all || {}) !==
            JSON.stringify(credentials)
        )
      ) {
        skipped.push(name)
        continue
      }

      const bypass = []
      if (!Array.isArray(entry.bypassList || []) || (entry.bypassList || []).length > 1000) {
        throw new Error('errorProfileFields')
      }

      for (const rule of entry.bypassList || []) {
        try {
          if (
            rule.conditionType !== 'BypassCondition' ||
            rule.pattern.includes('*') ||
            rule.pattern.includes('/')
          ) {
            throw new Error()
          }

          bypass.push(host(rule.pattern))
        } catch {
          unknownFields = true
        }
      }

      const p = profile({
        id: `zero:${name}`,
        name,
        color: Math.max(0, colors.indexOf(String(entry.color).toLowerCase())),
        type: endpoint.scheme,
        host: endpoint.host,
        port: endpoint.port,
        username: credentials.username,
        password: credentials.password,
        bypass
      })
      profiles.push(p)
      byName.set(name, p.id)
    }

    if (!profiles.length) {
      throw new Error('errorImportCompatible')
    }

    if (new Set(profiles.map(p => p.id)).size !== profiles.length) {
      throw new Error('errorDuplicateIds')
    }

    const resolve = (name, seen = new Set()) => {
      if (name === 'direct') {
        return 'DIRECT'
      }

      if (byName.has(name)) {
        return byName.get(name)
      }

      if (seen.has(name)) {
        return undefined
      }

      seen.add(name)
      const entry = data[`+${name}`]
      if (entry?.profileType === 'DirectProfile') {
        return 'DIRECT'
      }

      return entry?.profileType === 'VirtualProfile'
        ? resolve(entry.defaultProfileName, seen)
        : undefined
    }

    const switches = entries
      .map(([, entry]) => entry)
      .filter(entry => entry.profileType === 'SwitchProfile')
    const selected =
      switches.find(entry => entry.name === data['-startupProfileName']) || switches[0]
    const assignments = []
    const domains = []
    if (switches.length > 1) {
      unknownFields = true
    }

    if (selected) {
      const fallback = resolve(selected.defaultProfileName)
      // Active profile remains local; a fixed default cannot be imported as an automatic connection.
      if (fallback !== 'DIRECT') {
        unknownFields = true
      }

      if (!Array.isArray(selected.rules || []) || selected.rules.length > 1000) {
        throw new Error('errorImport')
      }

      if (selected.rules?.length) {
        unknownFields = true // Per-domain profile choices are not supported.
      }

      for (const rule of selected.rules || []) {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
          throw new Error('errorImport')
        }

        const id = resolve(rule.profileName)
        const condition = rule.condition
        if (!id || condition?.conditionType !== 'HostWildcardCondition') {
          unknownFields = true
          continue
        }

        for (let pattern of String(condition.pattern || '').split('|')) {
          try {
            let includeSubdomains = false
            if (pattern.startsWith('*.') || pattern.startsWith('.')) {
              pattern = pattern.replace(/^\*?\./, '')
              includeSubdomains = true
            }

            if (pattern.includes('*')) {
              throw new Error('errorRoutingPattern')
            }

            const domain = host(pattern)
            if (
              assignments.some(
                a =>
                  a.domain === domain ||
                  (a.includeSubdomains !== false && domain.endsWith(`.${a.domain}`))
              )
            ) {
              unknownFields = true
              continue
            }

            assignments.push({
              domain,
              profileId: id,
              ...(includeSubdomains ? {} : { includeSubdomains: false })
            })
            if (id !== 'DIRECT') {
              domains.push(includeSubdomains ? `**.${domain}` : domain)
            }
          } catch {
            unknownFields = true
          }
        }
      }
      // ZeroOmega uses first-match ordering; overlapping parents before children cannot be reproduced.
      if (
        assignments.some((a, i) =>
          assignments
            .slice(i + 1)
            .some(b => a.includeSubdomains !== false && b.domain.endsWith(`.${a.domain}`))
        )
      ) {
        unknownFields = true
      }
    }

    if (skipped.length) {
      unknownFields = true
    }

    return {
      profiles,
      skipped,
      missingPasswords: [],
      unknownFields,
      browserRouting: routing({ enabled: Boolean(selected), mode: 'domains', domains, assignments })
    }
  }

  function mergeImport(state, result, removeIds = []) {
    const existing = new Map(state.profiles.map(p => [p.id, p]))
    const imported = new Map(
      result.profiles.map(p => {
        const old = existing.get(p.id)
        const next = { ...p }
        if (old && p.portable) {
          for (const key of ['knockHost', 'bypass', 'authMode']) {
            if (!Object.hasOwn(p.portable.browser || {}, key)) {
              next[key] = old[key]
            }
          }
        }

        if (old && result.missingPasswords.includes(p.id)) {
          next.password = old.password
        }

        return [p.id, next]
      })
    )
    if (removeIds.some(id => imported.has(id) || !existing.has(id))) {
      throw new Error('errorProfileMissing')
    }

    const profiles = state.profiles
      .filter(p => !removeIds.includes(p.id))
      .map(p => imported.get(p.id) || p)
    profiles.push(...result.profiles.filter(p => !existing.has(p.id)))
    if (profiles.length > 1000) {
      throw new Error('errorImport')
    }

    const configuration = result.config ? structuredClone(result.config) : undefined
    if (configuration) {
      delete configuration.profiles
      if (result.unsupportedSplitProxy) {
        configuration.browser.routing = structuredClone(result.browserRouting)
      }
    }

    return {
      ...state,
      profiles,
      ...(result.browserRouting ? { browserRouting: result.browserRouting } : {}),
      activeId: profiles.some(p => p.id === state.activeId) ? state.activeId : null,
      ...(result.config
        ? {
            portable: configuration,
            theme: result.config.browser?.theme || state.theme,
            language: result.config.browser?.language || state.language,
            webRTC: result.config.browser?.webRTC || state.webRTC || 'browser',
            bypassLocalNetworks: result.bypassLocalNetworks
          }
        : {})
    }
  }

  function exportConfig(state, includePasswords = false) {
    if (!state.profiles.length) {
      throw new Error('errorImportCompatible')
    }

    if (state.profiles.some(p => p.type !== 'https' || p.host.includes(':'))) {
      throw new Error('errorExportProtocol')
    }

    const config = {
      ...structuredClone(state.portable || {}),
      schema: SCHEMA,
      version: 8,
      passwordsIncluded: includePasswords,
      privateKeysIncluded: false,
      activeProfileId: state.activeId,
      routing: {
        ...(state.portable?.routing || {}),
        bypassLocalNetworks: state.bypassLocalNetworks !== false
      },
      browser: {
        theme: state.theme,
        language: state.language,
        webRTC: state.webRTC || 'browser',
        routing: routing(state.browserRouting)
      },
      profiles: state.profiles.map(p => ({
        ...structuredClone(p.portable || {}),
        id: p.id,
        name: p.name,
        color: p.color,
        countryCode: p.countryCode,
        proxy: {
          ...(p.portable?.proxy || {}),
          type: 'HTTPS',
          host: p.host,
          port: p.port,
          username: p.username,
          ...(includePasswords ? { password: p.password } : {})
        },
        browser: {
          ...(p.portable?.browser || {}),
          knockHost: p.knockHost,
          bypass: p.bypass,
          authMode: p.authMode
        }
      }))
    }
    delete config.failover

    function stripSecrets(object) {
      for (const key of Object.keys(object)) {
        if (key === 'privateKey' || (key === 'password' && !includePasswords)) {
          delete object[key]
        } else if (object[key] && typeof object[key] === 'object') {
          stripSecrets(object[key])
        }
      }
    }

    stripSecrets(config)
    const exported = filterConfig(config).config
    if (root.MegaValidate && !root.MegaValidate(exported)) {
      throw new Error('errorProfileFields')
    }

    return exported
  }

  function webRTC(value) {
    if (
      ![
        'browser',
        'default',
        'default_public_and_private_interfaces',
        'default_public_interface_only',
        'disable_non_proxied_udp',
        'proxy_only',
        'disabled'
      ].includes(value)
    ) {
      throw new Error('errorProfileFields')
    }

    return value
  }

  root.MegaProxy = {
    defaults,
    webRTC,
    routeProfile,
    routingStrategy,
    host,
    domainPattern,
    routing,
    matchesDomain,
    routingPatterns,
    chromiumImplicitHost,
    routed,
    profile,
    active,
    localHost,
    bypassed,
    basic,
    hasCredentials,
    needsKnock,
    proxyInfo,
    auth,
    chromiumConfig,
    importProfiles,
    mergeImport,
    exportConfig,
    filterConfig,
    colors
  }
})(globalThis)
