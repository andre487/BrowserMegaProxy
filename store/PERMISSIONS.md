# Permission justifications

The following text explains every permission requested by the production manifests. Chromium includes Chrome and Opera. Firefox additionally requests `webRequestBlocking`. The `privacy` and `notifications` permissions are optional in both packages.

## Single purpose

MegaProxy manages browser connections through a user-provided HTTP, HTTPS or SOCKS5 proxy, with experimental MASQUE support in Firefox. Profiles, authentication, routing rules, connection checks and local diagnostics support that purpose. MegaProxy does not provide proxy servers.

## `proxy`

Required to apply the selected HTTP/HTTPS or SOCKS5 proxy and its bypass rules, generate domain-based routing in Chromium, and restore Direct or System connection settings. In Firefox, it also makes per-request proxy decisions for the optional By tabs routing mode. Firefox Android uses per-request decisions because it does not implement `proxy.settings`. These settings change how the browser connects to websites; they do not send browsing data to the developer.

## `storage`

Required to persist proxy profiles, saved usernames and passwords, routing rules and interface preferences. Browser `storage.sync` synchronizes profiles and preferences when browser synchronization is available; synchronization and password synchronization are enabled by default and can be disabled independently. Session storage retains temporary connection-check and knock-tab state across background-worker restarts. Credentials are stored without additional encryption by the extension. The developer does not operate a synchronization service.

## `scripting`

Required for a user-triggered connection check to read plain-text IP and country results from the temporary diagnostic tab created by the extension, limited to 256 characters per result. For HTTP 5xx diagnostics, the packaged script may also read up to 16,384 characters of visible error-page text in that tab. Known credentials, authorization fields and URLs are redacted, and the excerpt is limited to 4,096 characters before display or logging. This permission is not used to inject scripts into ordinary browsing pages or download executable code.

## `alarms`

Required to schedule freshness checks and updates for automatic domain lists used by selective proxy routing. List content is downloaded only when the current connection and routing settings need it. Alarms avoid keeping the extension's background process running continuously.

## `contextMenus`

Required to offer proxy profile selection, connection-mode switching and routing actions in the browser's context menus. These actions let users manage the current site's proxy routing without opening the settings page.

## `webRequest`

Required to observe proxy authentication challenges and the success or failure of knock-host and connection-check requests. It also supports user-disableable request counters and the local network monitor. Monitoring retains domains, request types, status/error information and routing results, without URL paths, query parameters or request bodies. Counters and monitoring are enabled by default and can be disabled. Diagnostic data is not sent to the developer.

## `webRequestAuthProvider`

Required to provide saved proxy credentials through `webRequest.onAuthRequired` when a matching proxy returns an authentication challenge (HTTP 407). The extension checks that the challenge is for a proxy and that its endpoint matches the selected profile. It does not supply proxy credentials to a website's HTTP authentication challenge.

## `webRequestBlocking` — Firefox only

Required by Firefox for the authentication listener's asynchronous blocking response. This allows the extension to return credentials for a matching proxy challenge or cancel a repeated unsuccessful authentication attempt. It is used for proxy authentication, not advertisement filtering or arbitrary modification of website content.

## `<all_urls>` — host access

Required because the user's proxy may serve requests to any HTTP or HTTPS website. Proxy authentication and request observation must work for arbitrary destination hosts, and Firefox's By tabs routing can apply to any site selected by the user. Host access also allows downloading a configuration from a user-entered URL, fetching domain-list data, and reading IP/country responses during a connection check. A fixed host allowlist would prevent authentication and routing from working for user-selected sites. Host access does not enable the developer to collect page content; the only injected page-reading script is used in the extension-created diagnostic tab. Browser-protected pages remain subject to browser restrictions.

## `privacy` — optional

Requested only when the user selects an extension-controlled WebRTC policy. It changes the browser's WebRTC IP-handling policy to limit connections that could expose an address outside the selected proxy route. The setting affects the whole browser, including pages using Direct connections, and may affect calls. Selecting Browser settings restores control to the browser. This permission is not required for basic proxy management.

## `notifications` — optional

Requested only when the user enables system notifications about changed connection
settings. It displays an update notice after effective active-proxy or routing changes,
including configuration subscriptions and Podkop list updates. Notices contain no
credentials or configuration body. Refusing this permission leaves the popup/settings
warning and toolbar indicator available; notifications are not needed for proxy management.

## Firefox data-collection declaration

`browser_specific_settings.gecko.data_collection_permissions.required` contains `none`. This is a Firefox declaration, not an additional API permission. The developer does not collect or transmit user data to a developer-operated service. Browser-managed settings/password synchronization and user-triggered or configured requests to proxy, diagnostic, configuration and domain-list endpoints are explained in the [privacy policy](PRIVACY.md).
