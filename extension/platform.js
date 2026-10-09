/* Browser-specific policy and native APIs. The API is injected; no browser globals inside adapters. */
;(root => {
  function firefoxProxyInfo(profile) {
    return {
      type: profile.type === 'socks5' ? 'socks' : profile.type,
      host: profile.host,
      port: profile.port,
      ...(profile.type === 'socks5'
        ? {
            proxyDNS: true,
            ...(profile.username ? { username: profile.username, password: profile.password } : {})
          }
        : root.MegaProxy.hasCredentials(profile)
          ? { proxyAuthorizationHeader: root.MegaProxy.basic(profile) }
          : {})
    }
  }

  class BrowserPlatform {
    constructor(api, core) {
      this.api = api
      this.core = core
    }

    get defaultTheme() {
      return 'system'
    }

    themePreference(value = 'system') {
      return value === 'system' ? this.defaultTheme : value
    }

    get supportsTabRouting() {
      return false
    }

    needsKnock(profile) {
      return Boolean(profile && profile.type !== 'socks5' && !this.core.hasCredentials(profile))
    }

    supportsWebRTC() {
      return true
    }

    implicitBypass() {
      return false
    }

    downgradeRouting() {
      return false
    }

    routingMode(mode) {
      return this.supportsTabRouting ? mode : 'domains'
    }

    routingHint(mode) {
      return mode === 'tabs' ? 'routingTabsHint' : this.domainHint
    }

    validateRouting(routing) {
      if (!this.supportsTabRouting && routing.mode === 'tabs') {
        throw new Error('errorSplitUnsupported')
      }
    }

    validateKnock() {}

    validateProfile() {}

    async checkPrivateAccess() {}

    async apply(state) {
      await this.checkPrivateAccess()
      const setting = await this.api.proxy.settings.get({})
      if (
        setting.levelOfControl &&
        !['controllable_by_this_extension', 'controlled_by_this_extension'].includes(
          setting.levelOfControl
        )
      ) {
        throw new Error('errorProxyControl')
      }

      const profile = this.core.active(state)
      this.validateProfile(profile)
      this.validateKnock(profile, state)
      await this.applySettings(profile, state)
    }

    async applyTransient() {}

    restoreKnockRefresh(data, current) {
      return current
    }

    async prepareKnock() {}

    async openedKnock() {}

    async tabUrl() {
      return ''
    }

    registerRouting() {}

    registerKnockRefresh() {}

    get tabMenus() {
      return []
    }
  }

  class ChromiumPlatform extends BrowserPlatform {
    get defaultTheme() {
      return 'dark'
    }

    get id() {
      return 'chromium'
    }

    get domainHint() {
      return 'routingDomainsChromiumHint'
    }

    needsKnock(profile) {
      return Boolean(profile && profile.type !== 'socks5')
    }

    validateProfile(profile) {
      if (profile?.type === 'socks5' && (profile.username || profile.password)) {
        throw new Error('errorSocksAuthUnsupported')
      }
    }

    supportsWebRTC(value) {
      return !['proxy_only', 'disabled'].includes(value)
    }

    implicitBypass(hostname, state) {
      return Boolean(state.browserRouting?.enabled && this.core.chromiumImplicitHost(hostname))
    }

    downgradeRouting(routing) {
      if (
        !routing ||
        !(
          routing.mode === 'tabs' ||
          routing.sites.length ||
          routing.subscriptions.siteSources.length
        )
      ) {
        return false
      }

      if (routing.mode === 'tabs') {
        routing.assignments = []
      }
      routing.mode = 'domains'
      if (routing.strategy === 'tabs') {
        routing.strategy = 'manual'
      }
      routing.sites = []
      routing.subscriptions.siteSources = []
      return true
    }

    validateKnock(profile, state) {
      if (profile && this.implicitBypass(profile.knockHost, state)) {
        throw new Error('errorKnockBypass')
      }
    }

    async applySettings(profile, state) {
      const settings = this.api.proxy.settings
      if (profile) {
        await settings.set({ value: this.core.chromiumConfig(profile, state), scope: 'regular' })
      } else if (state.connectionMode === 'direct' || state.downloadRouting) {
        await settings.set({ value: { mode: 'direct' }, scope: 'regular' })
      } else {
        await settings.clear({ scope: 'regular' })
      }
    }

    async applyTransient(state) {
      const temporary = Boolean(state.downloadRouting || state.routingExtraDomains)
      if (temporary) {
        await this.api.storage.session?.set({ transientProxyLease: true })
      }
      await this.apply(state)
      if (!temporary) {
        await this.api.storage.session?.set({ transientProxyLease: false })
      }
    }

    isSubscriptionDownload(details, routing) {
      return Boolean(routing?.hosts.includes(new URL(details.url).hostname))
    }

    restoreKnockRefresh(data, current) {
      return data.knockRefresh || current
    }

    async prepareKnock(profile, refresh, eligible, store) {
      const tabs = (await this.api.tabs.query({}))
        .filter(tab => eligible(tab, profile))
        .map(tab => ({ id: tab.id, url: tab.pendingUrl || tab.url }))
      Object.assign(refresh, {
        pending: { tabId: null, profileId: profile.id, host: profile.knockHost, tabs },
        profileId: null,
        tabs: []
      })
      await store()
    }

    async openedKnock(tab, refresh, store) {
      refresh.pending.tabId = tab.id
      await store()
    }

    registerKnockRefresh({ enqueue, forget, activate, finish }) {
      this.api.tabs.onRemoved?.addListener(tabId => enqueue(() => forget(tabId)))
      this.api.tabs.onUpdated?.addListener((tabId, change) => {
        if (change.url) {
          enqueue(() => forget(tabId, change.url))
        }
      })
      this.api.tabs.onActivated?.addListener(({ tabId }) => enqueue(() => activate(tabId)))
      this.api.webRequest.onCompleted.addListener(
        details => {
          if (details.type === 'main_frame') {
            enqueue(() => finish(details))
          }
        },
        { urls: ['<all_urls>'] }
      )
    }
  }

  class FirefoxPlatform extends BrowserPlatform {
    async apply(state) {
      if ((await this.api.runtime.getPlatformInfo?.())?.os === 'android') {
        // Android routes through onRequest; proxy.settings exists but rejects every call.
        await this.checkPrivateAccess()
        this.validateKnock(this.core.active(state), state)
        return
      }

      await super.apply(state)
    }

    get id() {
      return 'firefox'
    }

    get supportsTabRouting() {
      return true
    }

    get domainHint() {
      return 'routingDomainsHint'
    }

    get tabMenus() {
      return [['toggleTab', 'toggleTabMenu']]
    }

    async checkPrivateAccess() {
      if (!(await this.api.extension.isAllowedIncognitoAccess())) {
        throw new Error('errorPrivateBrowsing')
      }
    }

    async applySettings(profile, state) {
      if (profile || state.connectionMode === 'direct') {
        await this.api.proxy.settings.set({ value: { proxyType: 'none' } })
      } else {
        await this.api.proxy.settings.clear({})
      }
    }

    isSubscriptionDownload(details, routing) {
      return Boolean(
        routing?.hosts.includes(new URL(details.url).hostname) &&
        details.tabId === -1 &&
        (!details.originUrl || details.originUrl.startsWith(this.api.runtime.getURL('')))
      )
    }

    async tabUrl(details, state, cache, navigation) {
      if (
        !state.browserRouting.enabled ||
        state.browserRouting.mode !== 'tabs' ||
        details.tabId < 0
      ) {
        return ''
      }

      let url
      if (details.type === 'main_frame') {
        url = details.url
        if (navigation) {
          cache.set(details.tabId, url)
        }
      } else {
        url = cache.get(details.tabId)
      }

      if (!url) {
        cache.set(details.tabId, '')
        const tab = await this.api.tabs.get(details.tabId).catch(() => null)
        // A close or navigation while get() was pending must win over its stale result.
        if (cache.get(details.tabId) === '') {
          cache.set(details.tabId, tab?.url || '')
        }

        url = cache.get(details.tabId) || ''
      }

      return url
    }

    registerRouting({ ready, state, requestProfile, directRequest = () => false }) {
      this.api.proxy.onRequest.addListener(
        async details => {
          await ready
          const profile = await requestProfile(details, true)
          const current = state()
          if (
            !this.core.active(current) &&
            current.connectionMode !== 'direct' &&
            !directRequest(details)
          ) {
            return undefined
          }

          const info = profile ? firefoxProxyInfo(profile) : { type: 'direct' }
          return info.type === 'direct' ? info : [info, null]
        },
        { urls: ['<all_urls>'] }
      )
    }
  }

  const platforms = { chromium: ChromiumPlatform, firefox: FirefoxPlatform }
  root.MegaPlatform = {
    firefoxProxyInfo,
    create(target = 'firefox', api, core = root.MegaProxy) {
      const Platform = platforms[target]
      if (!Platform) {
        throw new Error(`Unsupported browser: ${target}`)
      }

      return new Platform(api, core)
    }
  }
})(globalThis)
