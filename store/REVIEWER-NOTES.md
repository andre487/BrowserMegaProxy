# Store submission notes

## Single purpose

Manage the browser’s connection through a user-provided HTTP/HTTPS or SOCKS5 proxy, including authentication, routing rules, configuration subscriptions and diagnostics for that connection. Firefox also offers experimental MASQUE, disabled by default. MegaProxy does not sell or supply proxy servers.

## Permissions justification

See [Permission justifications](PERMISSIONS.md) for a separate, ready-to-paste English justification for every requested API permission, host access and optional permission. The document also explains Firefox’s data-collection declaration.

There is no remote executable code. UI scripts and schema validation are packaged locally. Downloaded domain lists and configurations are parsed as data. Browser-generated PAC configuration in Chromium is built from validated settings, not a user-supplied script.

## Review steps

1. Install the browser-specific package. Chromium requires version 120+; Firefox requires 140+ (142+ on Android). In Firefox, allow private-window access; desktop proxy control uses `proxy.settings`, while Android uses `proxy.onRequest`.
2. Open settings. Add an HTTP or HTTPS CONNECT proxy you control. Save and select it. Test Proxy, Direct and System, then run a connection check.
3. Expand Routing mode. Test manual domains and subdomain wildcards, rule testing and automatic list selection. Firefox additionally exposes By tabs. Chrome and Opera do not offer tab routing.
4. Test import/export using non-sensitive HTTPS profiles. HTTP profiles and HTTPS proxies with IPv6 addresses cannot be exported under the portable contract. Imports also accept FoxyProxy, ZeroOmega, ProxyList and SuperProxy, with compatibility warnings.
5. Import a complete configuration from a URL you control and enable a subscription, or import a MegaProxy file containing `subscription`. Set the interval, pause automatic checks, and confirm **Update now** works in settings and popup while paused. Optional Basic Auth requires HTTPS. Use only trusted backup URLs because they receive the same configured credentials.
6. Change the active profile's endpoint in the subscription, then remove it in the next snapshot. A surviving local selection stays selected; a removed selection uses the downloaded `activeProfileId` or first supported profile. Direct/System remain unchanged; failed downloads retain the working configuration.
7. Confirm effective proxy or Podkop-rule changes show a popup/settings notice and toolbar `!`. New requests use the updated settings. Firefox advises reloading existing pages; Chromium recommends a restart for existing connections. Enable **System notifications when connection settings change** in settings to request optional consent; refusal does not block updates. Acknowledge the notice to clear it.
8. Inspect General preferences: theme, language, WebRTC, synchronization/password synchronization and request monitoring. Disable monitoring and confirm its UI disappears.
9. Open the local diagnostic log from the settings footer; test size limit, clearing and file export.

Firefox 146+ experimental MASQUE requires trusted TLS and a reachable UDP port, with
no username/password authentication. CONNECT-TCP scenarios are tested; HTTP/3 over
CONNECT-UDP is not confirmed. See the [MASQUE limitations](../README.md#experimental-masque-in-firefox).

No MegaProxy account is required. A Proxy-mode connection test needs a working proxy supplied by the reviewer. Direct and System checks work without a configured profile. Do not treat the illustrative `.example` servers in store screenshots as usable credentials. The repository’s `tests/megaproxy-server` fixtures support real-proxy automated tests; see [test setup and reports](../docs/testing.md).

## Browser packages

- Chrome Web Store: ZIP containing the contents of `dist/chromium`, with `manifest.json` at its root.
- Firefox Add-ons: ZIP containing the contents of `dist/firefox`. Mozilla signs the store distribution; development/PR archives are unsigned.
- Opera Add-ons: use the Chromium package. Assets and descriptions are prepared for its Chromium UI; a release must also be checked in the target Opera version before submission. Opera-specific runtime testing has not been performed by this asset generator.

Upload the extension package, not the store-materials ZIP. Provide a public URL for the privacy policy after this document is available on the default branch. For example: `https://github.com/andre487/BrowserMegaProxy/blob/main/store/PRIVACY.md`.

For Chrome’s privacy questionnaire, disclose browser synchronization of settings/passwords and user-triggered requests to external services as described in the policy. Do not claim that nothing ever leaves the device. The developer does not collect or sell this data.
