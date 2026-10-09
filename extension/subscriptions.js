/* global MegaProxy, MegaSubscriptionCatalog */
/* global MegaErrors */
;(root => {
  const base = 'https://raw.githubusercontent.com/itdoginfo/allow-domains/main/'
  const catalogURL =
    'https://api.github.com/repos/itdoginfo/allow-domains/git/trees/main?recursive=1'
  const day = 24 * 60 * 60 * 1000
  const sourceId = /^[a-z0-9][a-z0-9_-]{0,63}$/

  function source(path) {
    let id
    const simple = /^(?:Categories|Services)\/([a-z0-9][a-z0-9_-]{0,63})\.lst$/.exec(path)
    const regional = /^([A-Za-z][A-Za-z0-9_-]{0,31})\/(inside|outside)-raw\.lst$/.exec(path)
    if (simple) {
      id = simple[1]
    } else if (regional) {
      id = `${regional[1].toLowerCase()}_${regional[2]}`
    } else {
      return null
    }
    const name =
      {
        youtube: 'YouTube',
        google_ai: 'Google AI',
        google_play: 'Google Play',
        hdrezka: 'HDRezka',
        tiktok: 'TikTok',
        cloudfront: 'CloudFront',
        digitalocean: 'DigitalOcean'
      }[id] ||
      id
        .split(/[_-]/)
        .map(word => word[0].toUpperCase() + word.slice(1))
        .join(' ')
    return { id, name, path, url: base + path }
  }

  function parseCatalog(text) {
    let data
    try {
      data = JSON.parse(text)
    } catch (error) {
      throw new Error('errorListCatalog', { cause: error })
    }
    if (
      !data ||
      data.truncated !== false ||
      !Array.isArray(data.tree) ||
      data.tree.length > 10000
    ) {
      throw new Error('errorListCatalog')
    }
    const sources = data.tree
      .filter(entry => entry?.type === 'blob' && typeof entry.path === 'string')
      .map(entry => source(entry.path))
      .filter(Boolean)
      .sort((a, b) => a.id.localeCompare(b.id, 'en'))
    if (
      !sources.length ||
      sources.length > 256 ||
      new Set(sources.map(item => item.id)).size !== sources.length
    ) {
      throw new Error('errorListCatalog')
    }
    return { sources, updatedAt: Date.now(), attemptedAt: Date.now(), error: null }
  }

  function catalog(cache) {
    if (Array.isArray(cache?.sources) && cache.sources.length && cache.sources.length <= 256) {
      const sources = cache.sources.map(item =>
        typeof item?.path === 'string' ? source(item.path) : null
      )
      if (sources.every(Boolean) && new Set(sources.map(item => item.id)).size === sources.length) {
        return sources
      }
    }
    return MegaSubscriptionCatalog.sources
  }

  async function refreshCatalog(previous, fetcher = root.fetch, force = false) {
    if (!force && previous?.updatedAt && Date.now() - previous.updatedAt < day) {
      return { ...previous, sources: catalog(previous) }
    }
    try {
      return parseCatalog(await download(catalogURL, 2 * 1024 * 1024, fetcher))
    } catch (error) {
      return {
        ...previous,
        sources: catalog(previous),
        attemptedAt: Date.now(),
        error: 'errorListCatalog',
        errorDetails: MegaErrors.details(
          new Error('errorListCatalog', { cause: error }),
          'routingOpened'
        )
      }
    }
  }

  function coverage(ids, lists) {
    const indexes = new Map(ids.map(id => [id, new Set(lists[id].domains)]))
    const covers = (parent, child) =>
      lists[child].domains.every(h => ancestors(h).some(part => indexes.get(parent).has(part)))
    const result = []
    for (const id of ids) {
      const coveredBy = ids.find(
        other => other !== id && covers(other, id) && (!covers(id, other) || other < id)
      )
      if (coveredBy) {
        result.push({ sourceId: id, coveredBy })
      }
    }
    return result
  }

  const limit = 1000
  const sourceKey = options => JSON.stringify([options.domainSources, options.siteSources])

  function options(input = {}) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      ['autoUpdate', 'throughProxy'].some(
        key => input[key] !== undefined && typeof input[key] !== 'boolean'
      )
    ) {
      throw new Error('errorProfileFields', { cause: new Error('errorSubscriptionOptions') })
    }

    const result = {
      autoUpdate: input.autoUpdate ?? true,
      throughProxy: input.throughProxy ?? false
    }
    for (const key of ['domainSources', 'siteSources']) {
      const ids = input[key] ?? []
      if (
        !Array.isArray(ids) ||
        ids.length > 64 ||
        ids.some(id => typeof id !== 'string' || !sourceId.test(id))
      ) {
        throw new Error('errorProfileFields', { cause: new Error('errorSubscriptionSources') })
      }

      result[key] = [...new Set(ids)].sort()
    }

    return result
  }

  function domain(text) {
    // Accept only DNS names; ignore IPs, CIDRs, URLs and non-domain formats.
    if (
      typeof text !== 'string' ||
      !text.includes('.') ||
      /[\s*/:@?#\\]/.test(text) ||
      /^[\d.]+$/.test(text)
    ) {
      return null
    }

    try {
      const h = MegaProxy.host(text.replace(/^\.+/, ''))
      return h.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
        /[a-z]/.test(h.split('.').at(-1))
        ? h
        : null
    } catch {
      return null
    }
  }

  function generalize(domains) {
    const all = new Set(domains)
    return [...all]
      .filter(h => {
        const labels = h.split('.')
        return !labels.slice(1).some((_, index) => all.has(labels.slice(index + 1).join('.')))
      })
      .sort()
  }

  function parseDomains(text) {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
    if (lines.length > 200000) {
      throw new Error('errorListSize')
    }

    const domains = []
    let ignored = 0
    for (const line of lines) {
      const value = line.replace(/\s*(?:#|\/\/).*$/, '').trim()
      if (!value) {
        continue
      }

      const h = domain(value)
      if (h) {
        domains.push(h)
      } else {
        ignored++
      }
    }

    if (!domains.length) {
      throw new Error('errorListEmpty')
    }

    return { domains: generalize(domains), ignored }
  }

  function ancestors(h) {
    const labels = h.split('.')
    return labels.slice(0, -1).map((_, index) => labels.slice(index).join('.'))
  }

  function parseRanks(text, candidates) {
    const wanted = new Set(candidates.flatMap(ancestors))
    const ranks = {}
    let valid = 0
    for (const line of text.split(/\r?\n/)) {
      if (!line) {
        continue
      }

      const [position, raw, extra] = line.split(',')
      const rank = Number(position)
      const h = domain(raw)
      if (extra !== undefined || !Number.isInteger(rank) || rank < 1 || rank > 1000000) {
        throw new Error('errorRankingFormat')
      }

      valid++
      if (h && wanted.has(h)) {
        ranks[h] = Math.min(ranks[h] || Infinity, rank)
      }
    }

    if (!valid || valid > 1000000) {
      throw new Error('errorRankingFormat')
    }

    return ranks
  }

  function rank(h, ranks) {
    return (
      ancestors(h)
        .map(parent => ranks[parent])
        .find(value => value !== undefined) ?? Infinity
    )
  }

  function select(domains, manual, ranks, budget = limit) {
    const candidates = generalize(domains).filter(
      h =>
        !manual.some(
          pattern =>
            pattern === '*' || (pattern.startsWith('**.') && MegaProxy.matchesDomain(h, [pattern]))
        )
    )
    const scores = new Map(candidates.map(h => [h, rank(h, ranks)]))
    candidates.sort((a, b) => scores.get(a) - scores.get(b) || (a < b ? -1 : a > b ? 1 : 0))
    const selected = candidates.slice(0, Math.max(0, budget - manual.length))
    return {
      patterns: selected.map(h => `**.${h}`),
      total: candidates.length,
      dropped: candidates.length - selected.length,
      unranked: candidates.filter(h => scores.get(h) === Infinity).length
    }
  }

  function counts(state, mode) {
    const settings = options(state.browserRouting?.subscriptions)
    const cache = state.subscriptionCache
    if (cache?.sourceKey !== sourceKey(settings) || !cache.counts?.[mode]) {
      return null
    }

    const effective = new Set(MegaProxy.routingPatterns(state, mode))
    const omitted = (cache[mode] || []).filter(pattern => !effective.has(pattern)).length
    return { ...cache.counts[mode], dropped: cache.counts[mode].dropped + omitted }
  }

  async function download(url, maxBytes, fetcher = root.fetch, gzip = false) {
    const response = await fetcher(url, {
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-cache',
      signal: AbortSignal.timeout(30000)
    })
    if (!response.ok) {
      throw Object.assign(new Error('errorListDownload', { cause: new Error('errorHTTP') }), {
        status: response.status
      })
    }

    const stream = gzip ? response.body.pipeThrough(new DecompressionStream('gzip')) : response.body
    const reader = stream.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let bytes = 0
    let text = ''
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) {
          return text + decoder.decode()
        }

        bytes += chunk.value.byteLength
        if (bytes > maxBytes) {
          throw new Error('errorListSize')
        }

        text += decoder.decode(chunk.value, { stream: true })
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
  }

  async function update(config, previous = {}, fetcher = root.fetch, sources = catalog()) {
    const settings = options(config.subscriptions)
    const ids = [...new Set([...settings.domainSources, ...settings.siteSources])]
    const lists = {}
    // Bound concurrent downloads; keep only parsed domains while comparing source coverage.
    for (let start = 0; start < ids.length; start += 4) {
      const results = await Promise.allSettled(
        ids.slice(start, start + 4).map(async id => {
          const entry = sources.find(item => item.id === id)
          if (!entry) {
            throw new Error('errorListUnknownSource')
          }
          return [id, parseDomains(await download(entry.url, 4 * 1024 * 1024, fetcher))]
        })
      )
      const failed = results.find(result => result.status === 'rejected')
      if (failed) {
        throw failed.reason
      }
      Object.assign(lists, Object.fromEntries(results.map(result => result.value)))
    }
    const modes = {
      domains: generalize(settings.domainSources.flatMap(id => lists[id].domains)),
      sites: generalize(settings.siteSources.flatMap(id => lists[id].domains))
    }
    let ranks = previous.ranks || {}
    let rankingError = null
    let rankingErrorDetails
    let rankingId = previous.rankingId || null
    const overflow = Object.entries(modes).some(
      ([key, values]) => select(values, config.strategy ? [] : config[key], {}, limit).dropped > 0
    )
    if (overflow) {
      try {
        let csv, id
        const mirror = 'https://raw.githubusercontent.com/wangmm001/tranco-top1m-cache/main/data/'
        try {
          id = (await download(mirror + 'current.version.txt', 64, fetcher)).trim()
          if (!/^[A-Z0-9]{4,10}$/.test(id)) {
            throw new Error('errorRankingFormat')
          }

          csv = await download(mirror + 'current.csv.gz', 32 * 1024 * 1024, fetcher, true)
          ranks = parseRanks(csv, [...modes.domains, ...modes.sites])
        } catch {
          id = (await download('https://tranco-list.eu/top-1m-id', 64, fetcher)).trim()
          if (!/^[A-Z0-9]{4,10}$/.test(id)) {
            throw new Error('errorRankingFormat')
          }

          csv = await download(
            `https://tranco-list.eu/download/${id}/1000000`,
            32 * 1024 * 1024,
            fetcher
          )
          ranks = parseRanks(csv, [...modes.domains, ...modes.sites])
        }

        rankingId = id
      } catch (error) {
        rankingError = 'errorRankingUnavailable'
        rankingErrorDetails = MegaErrors.details(
          new Error(rankingError, { cause: error }),
          'updateSubscriptions'
        )
      }
    }

    const selected = Object.fromEntries(
      Object.entries(modes).map(([key, values]) => [
        key,
        select(values, config.strategy ? [] : config[key], ranks)
      ])
    )
    return {
      sourceKey: sourceKey(settings),
      coverage: {
        domains: coverage(settings.domainSources, lists),
        sites: coverage(settings.siteSources, lists)
      },
      updatedAt: Date.now(),
      attemptedAt: Date.now(),
      domains: selected.domains.patterns,
      sites: selected.sites.patterns,
      counts: Object.fromEntries(
        Object.entries(selected).map(([key, value]) => [
          key,
          { total: value.total, dropped: value.dropped, unranked: value.unranked }
        ])
      ),
      ignored: Object.values(lists).reduce((sum, list) => sum + list.ignored, 0),
      ranks,
      rankingId,
      rankingError,
      rankingErrorDetails,
      error: null
    }
  }

  root.MegaSubscriptions = {
    catalog,
    catalogURL,
    parseCatalog,
    refreshCatalog,
    coverage,
    limit,
    sourceKey,
    options,
    domain,
    generalize,
    parseDomains,
    parseRanks,
    select,
    counts,
    download,
    update
  }
})(globalThis)
