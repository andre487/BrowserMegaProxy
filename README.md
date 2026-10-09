# MegaProxy

[![CI](https://github.com/andre487/BrowserMegaProxy/actions/workflows/pr.yml/badge.svg?branch=main&event=push)](https://github.com/andre487/BrowserMegaProxy/actions/workflows/pr.yml?query=branch%3Amain+event%3Apush)
[![Firefox Android](https://github.com/andre487/BrowserMegaProxy/actions/workflows/android-firefox.yml/badge.svg?branch=main&event=push)](https://github.com/andre487/BrowserMegaProxy/actions/workflows/android-firefox.yml?query=branch%3Amain+event%3Apush)
[![Vivaldi Android](https://github.com/andre487/BrowserMegaProxy/actions/workflows/android-vivaldi.yml/badge.svg?branch=main&event=push)](https://github.com/andre487/BrowserMegaProxy/actions/workflows/android-vivaldi.yml?query=branch%3Amain+event%3Apush)
[![Release](https://img.shields.io/github/v/release/andre487/BrowserMegaProxy)](https://github.com/andre487/BrowserMegaProxy/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Chromium 120+](https://img.shields.io/badge/Chromium-120%2B-4285F4?logo=googlechrome&logoColor=white)](#build-and-install)
[![Firefox 140+](https://img.shields.io/badge/Firefox-140%2B-FF7139?logo=firefoxbrowser&logoColor=white)](#build-and-install)

Browser extensions for Chromium and Firefox.
HTTP/HTTPS CONNECT, SOCKS5 and experimental MASQUE (Firefox 146+), multiple profiles, authentication, knock hosts, domain exclusions,
profile import/export, local-network bypass, connection checks, and light/dark themes
(with automatic appearance in Firefox). The UI uses no external libraries or resources.

MegaProxy manages proxies you provide; it does not include proxy servers or a VPN service.
Safari and browsers without extension proxy APIs are not supported.

[Development](docs/development.md) · [Tests and reports](docs/testing.md) · [Release automation](RELEASING.md) · [Privacy](store/PRIVACY.md) · [Permissions](store/PERMISSIONS.md)

## Build and install

**Chrome:** [Install MegaProxy from the Chrome Web Store](https://chromewebstore.google.com/detail/megaproxy/kfilelfnldddoncicbampiojjjcpbigo).

For a local development build:

Requires Node.js 22+ and npm.

```sh
npm ci
npm run build
```

- **Chromium 120+**: `chrome://extensions` → Developer mode → Load unpacked → `dist/chromium`.
- **Firefox desktop 140+**: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `dist/firefox/manifest.json`. Allow private-window access in `about:addons`: Firefox requires it for `proxy.settings`. Permanent installation requires Mozilla signing.

On Android, Firefox requires **142+** and a signed package installed through Mozilla's
add-on distribution; `about:debugging` is a desktop installation method. For development,
see [Mozilla's Android extension guide](https://extensionworkshop.com/documentation/develop/developing-extensions-for-firefox-for-android/).
The Chromium build is also tested in Vivaldi Android; ordinary Chrome Android cannot
load it ([Google's installation guide](https://support.google.com/chrome_webstore/answer/2664769?hl=en)
offers only Add to Desktop from a phone).
See [mobile test coverage and limitations](docs/testing.md).

Each PR's separate **Installation archives** workflow publishes two ZIP artifacts:
**MegaProxy-chromium** and **MegaProxy-firefox**. Open the run from the PR checks,
download the archive from **Artifacts**, and extract it. Its `manifest.json` is at the
archive root; install the extracted directory as described above.
Artifacts are retained for 14 days. The archive workflow and PR-description update
finish independently of browser tests.
The latest archive links are maintained at the bottom of the PR description,
including release PRs that merge before the publication job starts.

Open Settings from the popup: profiles, import/export, routing, language and appearance
are on a separate page. Add a profile with a server address, port, username and password.
The popup provides quick actions to select and connect a profile, disconnect and knock.
Disconnect selects System and releases MegaProxy's proxy control. Changes to the active profile apply immediately.
Knock opens a separate tab, active when credentials are missing and otherwise in the background,
which closes automatically after a successful load.
Settings → Language offers Auto, Russian and English. Auto is the default:
`i18n.getUILanguage()` selects Russian for `ru` and its regional variants, and English
for other browser languages. Manual choices persist and apply immediately,
including errors and hints. Profile names are not translated.
Translations are in `extension/_locales/{en,ru}/messages.json`; the browser chooses the
extension description language independently of the manual UI selection.

Passwords are stored in `storage.local` and synchronized through `storage.sync` by default;
password sync can be disabled separately. MegaProxy does not encrypt them separately.
Chromium private-window access is disabled by default. Firefox requires private-window
permission for `proxy.settings`; the active profile applies in those windows too.

## Connection modes and network monitor

The popup and the top of Settings provide Proxy, Direct and System modes.
The choice updates across all open extension pages through local browser storage.
The selected profile remains selected when requests fail; there is no automatic
profile switching. Legacy Fallback mode migrates to Proxy without changing the
selected profile. Direct forces requests to connect without a proxy. System releases
MegaProxy's control and uses existing browser/system proxy settings. Disconnect
selects System. The connection mode stays local and is not synchronized or exported.
Configs containing the unsupported `failover` field show the unknown-fields warning;
that field is ignored and omitted from exports.

Selective routing chooses between the active profile and DIRECT. It never selects
another profile based on a domain. Browser authentication caches are tied to proxy
endpoints; use distinct endpoints for different credentials.

The icon shows the profile selected for the tab's top-level URL on a colored plate,
with long names fading out at the right edge and the full name in its tooltip.
Internal browser/extension pages show the active profile. Direct/System use DIR/SYS. Third-party resources follow the selected routing mode; their routes appear in the monitor.
System means browser-managed routing, whose external proxy is not inferred.
Badge updates run on navigation, activation and configuration changes rather
than every resource request.

The network monitor in Settings lists recent HTTP(S) resources, including direct
requests, optionally
filtered to failures (network errors or HTTP status >= 400). Select failed
domains and add them to the active manual domain list or Firefox tab-site list.
The action is hidden in other routing modes and does not switch modes. Data stays in memory and is never sent
anywhere. Only hostname, resource type, status/error, selected profile and time
are retained, without URL paths, query strings, headers, bodies or credentials.
Limits are 200 rows per tab and 50 tabs. Navigation, tab close, opt-out and
background restart clear their relevant entries. The journal has no per-request
storage writes, UI messages or badge changes. Refresh runs every five seconds
only while the monitor is open and visible.

### Optional request statistics

Statistics and network monitoring are enabled by default, with one local opt-out in Settings. Existing saved opt-out preferences remain respected. Counters track completed and failed MegaProxy requests. Direct requests are excluded. Statistics remain local in the browser and are never sent anywhere. Counters stay in memory, reset on opt-out or background-process restart, and never write storage per request. The statistics panel refreshes every five seconds only while its page is visible and statistics are enabled. Opting out removes the collecting listeners, clears the journal and counters, and hides both panels. The preference is local and is neither imported nor exported; no traffic-volume measurement is attempted.

## Profiles and routing

Profiles have stable IDs, colors, country codes, cloning and ordering.
Reorder using the drag handle with a mouse or touch; keyboard users can press
Up/Down while the handle has focus.
Local-network bypass is enabled by default and can be disabled in Settings.
It covers private IPv4, loopback, link-local, IPv6 ULA/link-local, localhost and
local names. Additional domain exclusions apply independently of that toggle.
Chromium CIDR rules work for IP literals in URLs; a private IP behind an ordinary
DNS name does not guarantee bypass. Add a domain exclusion for that name.

Full proxying routes requests through the selected profile, subject to exclusions.
Routing settings save automatically: toggles immediately, text fields on blur.
The selected profile remains active after request failures; automatic failover is not supported.

## Selective routing

Full proxying is the default, keeping all eligible requests on the active proxy.
Select a routing mode in Settings; manual lists accept one hostname pattern per line.
For destination-domain rules, exact hostnames match only themselves; `*` matches
any characters, including dots. `*.example.com` selects subdomains only, while
`**.example.com` selects the domain and its subdomains. In Firefox tab routing,
bare hostnames also include their subdomains. Empty lists connect directly.
Both modes respect local-network and profile bypass rules.

- **Destination domains (Chromium and Firefox):** only requests whose destination
  hostname matches the domain list use the proxy.
- **Split proxy by tab (Firefox):** tabs whose top-level hostname matches the site
  list use the proxy for their attributed requests, including resources on other
  domains. Requests without a tab go directly. The popup can override the current
  tab and reload it; the override lasts until the tab closes or routing settings
  change. Previously opened connections are not migrated.

The popup's **Add site to rules** action adds the current hostname and its subdomains to the current
mode's list and reloads that tab. Chromium hides tab routing and manual tab controls.
Chromium PAC routing always bypasses
localhost and link-local addresses; disabling local bypass cannot override this
browser restriction in selective mode. Other local ranges can still be proxied.
Required knock traffic and connection checks use the active proxy independently
of the saved inclusion lists.

Both modes export under `browser.routing` (`enabled`, `mode`, `domains`, `sites`)
without browser tab IDs or manual overrides. Importing Firefox `tabs` mode in
Chromium shows an explicit compatibility warning, discards the `sites` list and
uses destination-domain routing with the imported `domains` list. The extension
does not reinterpret tab site patterns as destination domains. The new browser
fields remain optional and compatible with Android's version 8 configuration.

## Podkop domain-list subscriptions

Selective routing offers predefined domain lists from
[itdoginfo/allow-domains](https://github.com/itdoginfo/allow-domains).
Subscriptions for destination-domain routing and Firefox split proxy are selected
independently. Settings save automatically. Updates run manually or daily while the
browser is running and the selected mode uses those lists. Failed updates retry
after an hour. “Update lists through the active proxy” uses the selected profile,
even with selective routing. Without an active profile it fails, without direct
fallback. When disabled, downloads bypass MegaProxy.

Only DNS names are used; IP addresses, CIDR and other formats are skipped.
A domain and all its subdomains become one `**.example.com` entry, matching both
`example.com` and `a.b.example.com`, but not `notexample.com`.
Legacy `*.example.com` still matches subdomains only. Duplicates and entries
covered by a parent present in the source are removed. Missing parent domains
are not invented: `a.example.com` is not broadened to `example.com`.
Manual rules remain separate.

Each mode has a limit of 1000 effective rules. Manual rules take priority, followed
by subscription rules ordered by [Tranco](https://tranco-list.eu/) ranking.
Rankings are downloaded only when truncation is needed: the primary source is a
daily [GitHub mirror](https://github.com/wangmm001/tranco-top1m-cache), with the
official Tranco site as fallback. The exact domain or its nearest ranked parent
is used. This approximates global popularity, not individual preferences.
Unranked domains follow ranked domains alphabetically; an absent rank does not
imply unpopularity. Unavailable rankings fall back to cached scores or alphabetical
order, with an explicit warning.

Settings show the number of dropped rules: those domains connect directly unless
covered by another rule. A failure to download any selected source preserves the
entire last successful version. Download limits are 4 MiB and 200,000 lines per
domain list, 32 MiB for the decompressed ranking, and 30 seconds per request.
Compiled rules and ranking scores are cached locally; browsing history is never uploaded.
Rank matching runs during updates, not on every request.

Subscription settings are in `browser.routing.subscriptions` and are exported;
cache, rankings, errors and download timestamps are not. Lists need refreshing
after import; automatic updates handle this when enabled and the mode uses them.
Chromium warns explicitly and discards tab rules and `siteSources`, even when the
imported Firefox configuration currently uses destination-domain routing.

Chromium temporarily applies routing for source hosts during downloads; this also
affects other requests to those hosts and includes mandatory PAC bypass of
localhost/link-local. Previous routing is restored after download, including on
failure. In Firefox, transport selection applies to extension background downloads.

Tranco: Victor Le Pochat et al. (2019), _Tranco: A Research-Oriented Top Sites
Ranking Hardened Against Manipulation_, NDSS,
[doi:10.14722/ndss.2019.23386](https://doi.org/10.14722/ndss.2019.23386).

### Dynamic community-list catalog

The available domain lists are discovered from the `itdoginfo/allow-domains`
GitHub file tree. Services, categories and regional raw lists are supported;
IP/subnet and generated non-domain formats are excluded. Existing source IDs
remain stable. A generated bundled snapshot keeps the UI usable offline; renew
it with `npm run renew-list-catalog` before a release.

The catalog refreshes daily alongside active subscriptions, or when Routing mode
is expanded and its cache is missing or stale, even with no selected lists.
It follows the same direct/proxy update preference. Failed catalog
refreshes retain the last successful data. Missing selected IDs stay visible and
are preserved on save/import; a failed list update preserves the previous rules.
Coverage warnings compare the selected source lists with hostname-suffix semantics
before popularity truncation, independently for domain and Firefox tab modes.
Downloads use at most four concurrent requests; source lists are not retained in
storage. The local catalog and coverage cache are not exported or synchronized.

Automatic list downloads run only when an active proxy uses selected lists in the
current routing mode and automatic updates are enabled. Other connection/routing
modes stop the background list alarm and make no subscription requests. Expanding
Routing mode in Settings refreshes a missing or stale catalog and, if currently
used, selected list contents. Fresh cached data makes no requests. Downloads exclude
list sources belonging to inactive routing modes. Manual list updates remain available.

## Authentication and probe resistance

| Browser  | Credentials before 407                                                      | Knock                                                                                           |
| -------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Firefox  | Saved credentials are supplied through `ProxyInfo.proxyAuthorizationHeader` | Opens on connection and browser startup without saved credentials; disabled when both are saved |
| Chromium | The browser controls the first CONNECT; credentials are supplied after 407  | Opens on connection and startup even with saved credentials                                     |

A knock host is optional: its absence does not prevent connecting a profile or show a warning.
When configured, a normal HTTPS tab opens, active when credentials are missing and otherwise in the background. Without a saved username
and password, MegaProxy leaves authentication to the browser's native dialog.
A repeated 407 challenge after supplying saved credentials opens MegaProxy's authentication window with focus requested,
including challenges from a background knock tab. On Android, the extension opens
an active authentication tab instead. Only one active dialog is opened per profile.
The dialog retains edits after a rejected attempt and allows cancellation. New
credentials stay in memory until the challenged request completes with an HTTP
response other than 407; then they are saved to that profile, the dialog closes automatically, and they are synchronized
according to the existing sync preferences. Network failures, cancellation, profile
changes, and failed local storage writes do not replace the saved credentials.
If a request expires while the dialog is open, reload its original page to retry.
Firefox disables the knock field and button when both username and password are saved,
without deleting the saved knock host.
After a successful HTTP response and completed load, the knock tab closes automatically.
Load errors, cancellation or unsuccessful authentication leave it open; a successful
retry still closes it after the page finishes loading. Chromium
retries a knock load once after `ERR_NETWORK_CHANGED`; subsequent errors leave
the tab open. Each new knock URL gets a random `r` query parameter to avoid
reusing a cached page; browser proxy-authentication caches still apply.
Repeated requests reuse an existing pending tab. Its state is retained in `storage.session`
so closing still works after the background process restarts.

Tests confirm credentials in Firefox's first CONNECT for HTTPS proxies.
For HTTP proxies, Firefox may wait for 407. This logic does not support HTTP proxies
with probe resistance and no challenge at the destination; use an HTTPS proxy for
such servers. `browser.authMode` remains for legacy imports, but Firefox always
requests immediate submission of saved credentials.

The `onAuthRequired` handler responds only to the active proxy, matching host/port
and `isProxy`. It first supplies saved credentials, then holds a repeated challenge
while the user edits credentials in the extension dialog. Concurrent requests do
not open additional dialogs. Credentials are never added to destination-site
headers or used for its 401 response.

For MegaProxyServer with `probe_resistance` enabled, add an allowed name to the
server's `knock` setting and use the same name in the extension profile.
That name needs a working HTTPS website for a successful page load after CONNECT;
an allowed server-side knock hostname is sufficient to obtain the 407 itself.
No public knock hosts are selected automatically. Knock must not be bypassed.
Opening a tab alone does not verify successful authentication. Switching profiles
may require a new knock because of browser authentication caches.

HTTPS here means TLS **to the proxy**, regardless of the destination website's scheme.
HTTP proxies transmit Basic credentials without TLS on the connection to the proxy.
HTTPS proxy certificates are verified; disabling verification is unsupported.
Use a certificate trusted by the browser.
Bypass domains include their subdomains without requiring wildcards or PAC.
Firefox returns a chain ending in `null` to prevent direct fallback.
Chromium uses one fixed proxy.

## Configuration compatibility

The shared version 8 contract, English documentation, schemas and examples are in
[MegaProxyConfig](https://github.com/andre487/MegaProxyConfig).
The build generates a CSP-compatible validator from the local schema: version 8
imports and exports use the same schema as the tests. Builds and tests never fetch schemas.

```sh
npm run renew-config-schema
npm run renew-config-schema -- --ref=<full-commit>
```

This command updates `config-schema/`: both schemas, the license, commit and SHA-256
values in the lock file. Review and commit schema copies and the lock file together.
The formatter excludes this directory to preserve original bytes and checksums.
The renewal command also applies the browser additions in
`scripts/config-schema-overrides.mjs`; `schema-lock.json` records upstream and
effective checksums. Review those overrides when adopting a newer upstream schema.

Imports accept MegaProxy JSON, ZeroOmega JSON, FoxyProxy JSON (`https`/`ssl`,
`hostname`/`address`), ProxyList and Android-compatible SuperProxy format.
HTTP and SOCKS5 profiles are accepted too. SSH, jump chains, PAC and disabled
certificate verification are skipped with a warning. FoxyProxy URL rules are not
transferred. Unknown or unsupported fields trigger one warning before applying:
“Configuration contains unknown fields.” Those fields are neither retained nor
exported. Limits are 1 MiB per file and 1000 profiles. Imported files may contain
passwords; do not commit them.

Import review shows new, updated and skipped profiles. Matching IDs update without
duplicates or changing local order. A missing password preserves the local value;
an explicit empty string clears it. Local profiles absent from the file remain,
and can be selected for deletion. Import does not connect the file's active profile.
Changes to an already active profile apply after confirming the import.

Exports use MegaProxy JSON version 8. Passwords are included by default and can
be excluded with a separate toggle. Unsupported Android fields are discarded on
import with the general warning. The Android version 8 baseline used by the shared contract does not support HTTP, SOCKS5
or IPv6 literals in the proxy host field. HTTP and HTTPS/IPv6 exports fail explicitly
without changing their protocol; SOCKS5 exports use the shared schema and require
a supporting client. Android ignores new `browser` blocks but currently drops
them on export: a complete round trip through Android requires the application to
preserve unknown fields.

SOCKS5 uses proxy-side DNS. Firefox supports SOCKS5 username/password authentication;
Chromium supports only anonymous SOCKS5. Its profile editor disables the credential
fields with an explanation, and imports with SOCKS5 credentials report an explicit
compatibility error. SOCKS5 does not use HTTP proxy authorization or knock hosts.
The shared configuration accepts `SOCKS5`; current Android clients require an update
to support that value and must report unsupported profiles instead of changing the protocol.

## ZeroOmega import compatibility

Import accepts ZeroOmega/SwitchyOmega settings JSON (`schemaVersion` 1 or 2,
`+name` profiles), from files or the existing config URL importer. It transfers
compatible HTTP/HTTPS/SOCKS5 fixed profiles, credentials, simple hostname bypasses,
virtual-profile references and a selected switch profile's hostname rules.
`*.example.com` becomes an apex-and-subdomains domain rule; exact hostnames remain
exact. Per-domain profile choices are not imported and produce a review warning. Imported settings never activate a profile.
A knock host is optional.

SOCKS4, user PAC, downloaded rule lists, regex/full-URL/time conditions, unequal
per-protocol endpoints or credentials, multiple switch trees and incompatible
rule ordering produce review warnings or skipped profiles. A fixed switch
default cannot activate a local connection automatically and is warned about.
Unsupported settings are not retained. Arbitrary subscription URLs, user PAC
scripts and a separate startup-profile selector remain deliberately out of scope.

## Connection checks

Checks use the active connection and a normal background browser tab, closing it
when complete. Stages follow Android: an HTTPS request to `example.com`, exit IP
(`ifconfig.me`, `api.ipify.org`, `icanhazip.com`) and country (`ifconfig.co`,
`ipapi.co`, `api.country.is`), with fallback between providers. Country is optional.
The total timeout is 45 seconds; each attempt has a 10-second timeout. In Proxy
mode, bypassed diagnostic hosts prevent the test so a direct request cannot be
presented as a proxy check. Checks are also available in Direct and System modes
without a profile. Results show the profile or connection mode, protocol, HTTPS
page loading time, exit IP and, when available, a country flag, code and localized
country name. Loading time is not a ping measurement.

## WebRTC, sync and routing tools

Settings provide browser-wide native WebRTC privacy controls. Chromium and Firefox
can restrict interfaces and non-proxied UDP; Firefox can additionally disable
WebRTC or require proxy-only TURN connections. The optional `privacy` permission
is requested when selecting a controlled policy. “Use browser settings” releases
MegaProxy's control. These preferences affect direct sites too and may affect calls.

Browser sync and password sync are enabled by default, with separate opt-out
controls. `storage.sync` uses the browser's configured account and sync service;
the extension cannot reliably detect whether account sync is configured. It
reads an existing remote snapshot before publishing local profiles on startup.
The active connection, request statistics, downloaded lists and granted permissions
remain local. Password opt-out excludes passwords from incoming and outgoing
snapshots and retains existing local passwords. Complete snapshots use revisioned
chunks; the last published configuration wins. The 45,000-byte payload limit leaves
room for both old and new snapshots within browser quotas. Failures preserve local
settings and appear in the sync status. HTTP, HTTPS and IPv6 profiles are supported
by sync independently of the portable Android export's stricter protocol limits.

The context menu offers connect/disconnect, proxy the current site (including
subdomains), exclude the current site, settings, and Firefox split-tab toggle.
No keyboard shortcuts are registered. The routing tester evaluates saved rules
without making a network request; specify a tab URL to test third-party resources
in split-proxy mode. URL import accepts HTTP(S), downloads at most 1 MiB with a
30-second timeout, and uses the same validation, review and warnings as file import.

Selective routing uses one selected profile in both browsers. Matching destination domains
(or matching top-level sites in Firefox tab mode) use that profile; other traffic goes DIRECT.
Local/profile bypass and Firefox manual DIRECT tab choices take precedence.
Legacy per-domain profile assignments are ignored on import with a general warning.
Their existing domain lists are retained; an obsolete `profiles` strategy becomes `manual`.
Stored configurations and synchronized preferences receive the same normalization.

We deliberately retain one global active profile. SOCKS4/QUIC, user PAC files,
container/private-window profiles, regular expressions and full-URL routing,
full request-content logs, automatic backups, enterprise policies and bulk editing are outside
the scope of this client. New unit and Playwright scenarios run in the existing
GitHub PR workflow. Browser-account cloud transport is not automated: tests cover
the storage API protocol, opt-out, malformed snapshots and quota failures locally.

In Chromium, a successful knock (HTTP 2xx/3xx on its main page) schedules a
one-time refresh for HTTP(S) tabs that were already open when knock started and
are routed through the active proxy. They reload only when activated. Direct,
extension/browser and already-discarded tabs are excluded. Navigating elsewhere
or closing a tab removes its marker; a failed knock does not schedule refreshes.
Markers remain local in `storage.session`, survive service-worker suspension,
and are cleared with the browser session. Firefox does not use this behavior.

## Diagnostic log

The Settings footer opens a separate diagnostic log page. Entries stay locally in
IndexedDB, without storage.sync or network uploads. The log records startup,
settings changes, connection checks and main-document/Fetch request errors; it
excludes passwords, authorization headers, URLs and proxy hostnames. Consecutive
identical events within a batch share a repetition count. Writes are batched for
500 ms with a bounded pending buffer; a crash can lose the pending batch.
The retained UTF-8 text is limited to 3 MiB by default (configurable from 1 to
10 MiB), with oldest batches deleted when the limit is exceeded. This is a
logical text limit; database overhead is additional. The viewer loads a bounded
recent tail and refreshes once a second while visible. It follows new entries
while at the bottom, preserves the reading position after scrolling upwards,
and resumes following when the user returns to the bottom. Export includes all
retained entries; Clear removes the persisted log.

## Interface and appearance

The settings page uses native dialogs for profile editing and URL imports.
A single mode selector shows the controls for manual domain rules, automatic
lists or Firefox tabs. Inactive settings
are preserved, but only the selected strategy affects routing. The optional
`browser.routing.strategy` is exported and synchronized; omitting it preserves
legacy combined routing. The connection check is available at the top for Proxy, Direct and
System; the footer shows the package version and Git commit (`+dirty` for
modified working trees). Chromium defaults to dark and offers explicit light/dark
themes; old `system` preferences migrate to dark. Firefox also supports automatic
appearance via `prefers-color-scheme`.

The popup fits 320px mobile screens and stays centered when opened as a browser
tab. Dialogs and forms reflow on narrow screens; controls use larger touch targets
for coarse pointers. Modern desktop browsers supporting `appearance: base-select`
use a CSS-styled native picker anchored to its control. Touch devices and browsers
without that support keep their platform picker.

## Releases

Release PR preparation, checks, tagging and archive publication are documented in
[RELEASING.md](RELEASING.md).

## Troubleshooting

- If a profile does not connect, check its host, port and protocol: HTTPS means
  TLS to the proxy, not just an HTTPS destination. Check the proxy's certificate
  and saved credentials; a probe-resistant server may require a configured knock host.
- If a site connects directly, check the connection mode, selected routing mode,
  local-network bypass and profile exclusions. Use the routing tester with the
  destination URL, and a tab URL for Firefox tab routing. Automatic-list truncation
  warnings are shown in Settings.
- If the popup cannot contact the background process, open the extension's errors
  in `chrome://extensions` or its debugger in `about:debugging`, then reload the
  extension. Include the browser/version, reproduction steps and diagnostic log
  in a [bug report](https://github.com/andre487/BrowserMegaProxy/issues), without
  credentials or sensitive configuration exports.

## Store materials

English and Russian listings, screenshots, icons and promotional materials for Chrome Web Store,
Firefox Add-ons and Opera Add-ons are available in [store/](store/README.md).
Regenerate images with `npm run store:assets`.

### Experimental MASQUE in Firefox

Firefox 146+ can use a MASQUE proxy over HTTP/3 (QUIC). Select MASQUE in the
profile editor and enter the proxy host and UDP port. The default path template
is `/.well-known/masque/udp/{target_host}/{target_port}/`; custom paths must retain
both placeholders. Username/password authentication is disabled: Firefox supplies the Basic header
for CONNECT-TCP but omits it for CONNECT-UDP. Use an anonymous or IP-allowlisted proxy.
Knock hosts are not used. Chromium rejects MASQUE profiles with a specific error.

The proxy requires a trusted TLS certificate and reachable UDP port. Firefox must
have HTTP/3 enabled. Firefox may disable HTTP/3 when third-party certificate roots
are present; this extension does not change browser TLS or HTTP/3 preferences.
This is browser HTTP(S) proxying, not a system VPN or a promise to route WebRTC.

For **GOST 3.3.0**, use the native `http3` listener (its `h3` listener implements a
different tunnel):

```yaml
services:
  - name: masque
    addr: :8443
    handler:
      type: masque
    listener:
      type: http3
      metadata:
        enableDatagrams: true
      tls:
        certFile: cert.pem
        keyFile: key.pem
```

JSON imports/exports preserve `proxy.type: "MASQUE"` and
`browser.masqueTemplate`. This is currently a browser schema addition, recorded
in `config-schema/schema-lock.json`; clients must explicitly support it.
`masque://proxy.example:8443` imports use the default template.

Run the standalone real Firefox/GOST test without Docker:

```sh
npm run build
npm run prepare:gost-e2e
npx playwright test tests/masque.spec.mjs --project=firefox
```

The test downloads GOST 3.3.0 with a pinned SHA-256 checksum and temporary TLS
certificates. HTTP/HTTPS CONNECT-TCP and failure without a direct fallback pass.
The separate CONNECT-UDP test reproduces a **GOST 3.3.0 limitation**: the inner
HTTP/3 server's QUIC datagram exceeds the outer tunnel's datagram size and GOST
closes the tunnel with `DATAGRAM frame too large`. Successful HTTP/3 page loading
through GOST is therefore not confirmed. This test asserts that specific failure;
it must become a successful-load test when upgrading to a GOST version that fixes
oversized datagrams. Test-specific certificate exceptions stay in the temporary
Firefox profile.
