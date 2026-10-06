# MegaProxy

Browser extensions for Chromium and Firefox.
HTTP/HTTPS CONNECT, multiple profiles, authentication, knock hosts, domain exclusions,
profile import/export, local-network bypass, connection checks, and light/dark themes
(with automatic appearance in Firefox). The UI uses no external libraries or resources.

## Releases

Release PR preparation, checks, tagging and archive publication are documented in
[RELEASING.md](RELEASING.md).

## Store materials

English and Russian listings, screenshots, icons and promotional materials for Chrome Web Store,
Firefox Add-ons and Opera Add-ons are available in [store/](store/README.md).
Regenerate images with `npm run store:assets`.

## Build and install

Requires Node.js 22+ and npm.

```sh
npm ci
npm run build
```

- **Chromium 120+**: `chrome://extensions` → Developer mode → Load unpacked → `dist/chromium`.
- **Firefox 128+**: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `dist/firefox/manifest.json`. Allow private-window access in `about:addons`: Firefox requires it for `proxy.settings`. Permanent installation requires Mozilla signing.

Each PR's **Extension checks** workflow publishes two ZIP artifacts:
**MegaProxy-chromium** and **MegaProxy-firefox**. Open the run from the PR checks,
download the archive from **Artifacts**, and extract it. Its `manifest.json` is at the
archive root; install the extracted directory as described above.
Artifacts are retained for 14 days and uploaded immediately after building, before tests run.

Open Settings from the popup: profiles, import/export, routing, language and appearance
are on a separate page. Add a profile with a server address, port, username and password.
The popup provides quick actions to select and connect a profile, disconnect and knock.
Disconnect restores the browser's previous settings. Changes to the active profile apply immediately.
Knock opens a separate background tab, which closes automatically after a successful load.
Settings → Language offers Auto, Russian and English. Auto is the default:
`i18n.getUILanguage()` selects Russian for `ru` and its regional variants, and English
for other browser languages. Manual choices are saved locally and apply immediately,
including errors and hints. Profile names are not translated.
Translations are in `extension/_locales/{en,ru}/messages.json`; the browser chooses the
extension description language independently of the manual UI selection.

Passwords are stored in `storage.local` and synchronized through `storage.sync` by default;
password sync can be disabled separately. MegaProxy does not encrypt them separately.
Chromium private-window access is disabled by default. Firefox requires private-window
permission for `proxy.settings`; the active profile applies in those windows too.

## Development launcher

Install a current regular Google Chrome and/or Firefox. macOS, Linux and Windows
are supported; Node.js 22+ and `npm ci` are required.

```sh
npm start             # Chrome by default
npm start --chrome    # Chrome
npm start --firefox   # Firefox
npm start -- --watch  # Chrome with automatic rebuilds
npm start -- --firefox --watch # Firefox with automatic rebuilds
```

Some npm versions warn about unknown flags. The portable argument syntax is
`npm start -- --chrome` and `npm start -- --firefox`.

`--watch` monitors `extension/` and `scripts/build.mjs`: changes rebuild and reload
the extension without restarting the browser. Settings are preserved.
Chrome also refreshes open extension tabs; Firefox extension pages may need to be
reopened. Build errors appear in the terminal; watching continues until the next change.

Every launch rebuilds the extension and loads it automatically.
Persistent, separate browser profiles live in `.browser-profiles/chrome` and
`.browser-profiles/firefox`; this directory is excluded from Git. Proxy profiles,
language, theme and other browser data survive restarts. Close the previous session
before launching again. Exit by closing the browser or pressing Ctrl+C in the terminal.

Chrome opens the extension UI in a tab. Current regular Chrome
[disables `--load-extension`](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY),
so the launcher uses DevTools Protocol with `--enable-unsafe-extension-debugging`
only in its separate development profile.
Firefox opens `about:addons` and installs a temporary add-on on every launch through
the local Mozilla DevTools server. The add-on receives the private-window permission
required for `proxy.settings` in its separate profile. Add-on data is preserved;
Mozilla signing is not needed for this launch method.

On macOS, Firefox is located in `/Applications/Firefox.app`; on Linux, as `firefox`
in PATH; on Windows, in Program Files / Program Files (x86) / LocalAppData.
Chrome is located in its standard installation directory. Linux requires a graphical
session for `npm start`.

## Authentication and probe resistance

| Browser  | Credentials before 407                                                      | Knock                                                                                           |
| -------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Firefox  | Saved credentials are supplied through `ProxyInfo.proxyAuthorizationHeader` | Opens on connection and browser startup without saved credentials; disabled when both are saved |
| Chromium | The browser controls the first CONNECT; credentials are supplied after 407  | Opens on connection and startup even with saved credentials                                     |

A knock host is optional: its absence does not prevent connecting a profile or show a warning.
When configured, a normal HTTPS tab opens in the background. Without saved credentials,
the browser displays its authentication dialog. Passwords entered there remain in the
browser; the extension does not read them or copy them into a profile.
Firefox disables the knock field and button when both username and password are saved,
without deleting the saved knock host.
After a successful HTTP response and completed load, the knock tab closes automatically.
Load errors, cancellation or unsuccessful authentication leave it open.
Repeated requests reuse an existing pending tab. Its state is retained in `storage.session`
so closing still works after the background process restarts.

Tests confirm credentials in Firefox's first CONNECT for HTTPS proxies.
For HTTP proxies, Firefox may wait for 407. This logic does not support HTTP proxies
with probe resistance and no challenge at the destination; use an HTTPS proxy for
such servers. `browser.authMode` remains for legacy imports, but Firefox always
requests immediate submission of saved credentials.

The `onAuthRequired` handler responds only to the active proxy, matching host/port
and `isProxy`. A repeated challenge for the same request is canceled. Credentials
are never added to destination-site headers or used for its 401 response.

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

Imports accept MegaProxy JSON, ZeroOmega JSON, FoxyProxy JSON (`https`/`ssl`,
`hostname`/`address`), ProxyList and Android-compatible SuperProxy format.
Supported HTTP profiles are accepted too. SSH, jump chains, PAC and disabled
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
import with the general warning. Current Android does not support HTTP or IPv6
literals in the proxy host field; exporting such profiles fails explicitly without
changing their protocol. Android ignores new `browser` blocks but currently drops
them on export: a complete round trip through Android requires the application to
preserve unknown fields.

## Connection checks

Checks use the active connection and a normal background browser tab, closing it
when complete. Stages follow Android: an HTTPS request to `example.com`, exit IP
(`ifconfig.me`, `api.ipify.org`, `icanhazip.com`) and country (`ifconfig.co`,
`ipapi.co`, `api.country.is`), with fallback between providers. Country is optional.
The total timeout is 45 seconds; each attempt has a 10-second timeout. In Proxy
mode, bypassed diagnostic hosts prevent the test so a direct request cannot be
presented as a proxy check. Checks are also available in Direct and System modes.

## Linting and formatting

[Prettier](https://prettier.io/) is the only formatter for JS/MJS, HTML, CSS,
JSON, Markdown and YAML. `.prettierrc.json` configures two-space indentation,
single quotes, no unnecessary semicolons and a preferred line width of 100.
Long expressions wrap automatically; string literals may exceed that width.

[ESLint](https://eslint.org/) checks JavaScript using its recommended rules.
Environments and additional rules are in `eslint.config.mjs`; extension globals
are also declared in `/* global … */` comments.
`eslint-config-prettier` disables rules that conflict with formatting.
Tool versions are pinned in `package.json` and the lock file. `.gitignore` entries
are excluded from formatting; `config-schema` is excluded separately to preserve
source-file checksums.

```sh
npm run lint         # ESLint + Prettier formatting check
npm run lint:fix     # ESLint fixes, then Prettier formatting
npm run format       # Format the entire project with Prettier
npm run format:check # Check formatting without changing files
```

In VS Code, install the recommended **Prettier** (`esbenp.prettier-vscode`) and
**ESLint** (`dbaeumer.vscode-eslint`) extensions. Repository settings enable
formatting and ESLint fixes on save.

Separate functions with blank lines and distinguish logical blocks within functions.
ESLint's `curly: all` requires braces for every `if`, `else` and loop; Prettier
places block bodies on separate lines. Prettier preserves blank lines but does not
automatically determine logical boundaries.

## Checks and pull requests

```sh
# Requires Docker with a running daemon, uv, Git and OpenSSL.
npx playwright install chromium firefox
npm run check
```

[.github/workflows/pr.yml](.github/workflows/pr.yml) runs checks on every PR:

- ESLint: code quality rules for all JS/MJS files; errors and warnings block the PR.
- Prettier: consistent JS/MJS, HTML/CSS/JSON, Markdown and YAML formatting; differences block the PR.
- Node: validation, Unicode Basic, routing, imports, retry limits and credential protection.
- Playwright Chromium: installed MV3 extension, a real proxy challenge, knock, subsequent CONNECT and no credentials reaching the origin.
- Playwright Firefox: temporary add-on installation through Mozilla DevTools Protocol; a test-only sidecar in a temporary copy invokes the normal background handler and is excluded from builds. Playwright checks real network requests; controlling `moz-extension` pages is unsupported.
- MegaProxyServer: real GOST 3.3.0 and HAProxy in Docker, templates and exports from a pinned server commit; HTTPS/407, camouflage with and without knock, separate chain camouflage settings, direct and SNI-chain routes (including a server with no direct route), IP endpoints, invalid/empty credentials, no origin credential leaks, exit failure without direct fallback, split proxy, proxied subscriptions, diagnostics and request-statistics preferences.
- Chrome development launcher: current code after relaunch and language persistence in a separate profile, when regular Chrome is installed.
- Chromium and Firefox UI: create/edit/delete, imports, themes, keyboard access and mobile widths; automatic browser-language selection, persisted manual choices, translated errors and form preservation on language changes.

## Code organization

`extension/platform.js` contains the shared `BrowserPlatform` class and its
`ChromiumPlatform` and `FirefoxPlatform` implementations. They handle native proxy
settings, authentication and knock, tab routing, available UI capabilities and
import compatibility. The concrete implementation is selected at startup; shared
handlers and UI call its methods. Browser APIs and core functions are constructor
arguments; operation-specific dependencies are method arguments, without a DI container.

Run `npm run check` before changing adapter behavior: unit tests cover edge cases
and settings restoration; Playwright checks real Chromium and Firefox, including
MegaProxyServer interoperability.

## References and assets

- [AndroidMegaProxy](https://github.com/andre487/AndroidMegaProxy): Basic credentials in the first CONNECT.
- [MegaProxyServer](https://github.com/andre487/MegaProxyServer): JSON exports, SNI chains and knock with probe resistance.
- [FoxyProxy](https://github.com/foxyproxy/browser-extension): matching proxy challengers and limiting retries.
- [Mozilla ProxyInfo](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/proxy/ProxyInfo),
  [proxy.onRequest](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/proxy/onRequest),
  [Chrome webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest),
  [Playwright extensions](https://playwright.dev/docs/chrome-extensions).

Code is written for this repository; source code from other extensions is not copied.
The icon comes from [AndroidMegaProxy](https://github.com/andre487/AndroidMegaProxy/blob/main/fastlane/metadata/android/en-US/images/icon.png)
under MIT. The original PNG and browser sizes are in `extension/icons`, alongside
the upstream license. The Android repository has no vector source.
Toolbar icons are separate PNGs with rounded transparent corners at 16, 24, 32 and
48 px. Regenerate them from the original logo with `node scripts/renew-toolbar-icons.mjs`
(requires installed Playwright Chromium).

## Selective routing

Full proxying is the default, keeping all eligible requests on the active proxy.
Select a routing mode in Settings; manual lists accept one hostname pattern per line.
Exact hostnames match only themselves; `*` matches any characters, including dots.
For example, `*.example.com` selects subdomains, not `example.com`. Empty lists
connect directly. Both modes respect local-network and profile bypass rules.

- **Destination domains (Chromium and Firefox):** only requests whose destination
  hostname matches the domain list use the proxy.
- **Split proxy by tab (Firefox):** tabs whose top-level hostname matches the site
  list use the proxy for their attributed requests, including resources on other
  domains. Requests without a tab go directly. The popup can override the current
  tab and reload it; the override lasts until the tab closes or routing settings
  change. Previously opened connections are not migrated.

The popup's **Add site to rules** action adds the current hostname to the current
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
Lists and scores are cached locally; browsing history is never uploaded.
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

### Optional request statistics

Statistics and network monitoring are enabled by default, with one local opt-out in Settings. Existing saved opt-out preferences remain respected. Counters track completed and failed MegaProxy requests. Direct requests are excluded. Statistics remain local in the browser and are never sent anywhere. Counters stay in memory, reset on opt-out or background-process restart, and never write storage per request. The statistics panel refreshes every five seconds only while its page is visible and statistics are enabled. Opting out removes the collecting listeners, clears the journal and counters, and hides both panels. The preference is local and is neither imported nor exported; no traffic-volume measurement is attempted.

### Server integration tests

`npm run test:e2e` prepares the pinned MegaProxyServer checkout, its locked Python dependencies (using uv), and Docker images before running all Playwright tests. GitHub Actions runs this on every PR and push to `main`, and retains Playwright traces and server logs on failure. No remote server is provisioned: each test creates and removes its own Docker network, GOST entry/exit servers, HAProxy frontend, origin, certificates and browser profiles.

Versions are pinned in `tests/megaproxy-server/versions.json`. To run only these tests locally:

```sh
npm run build
npm run prepare:server-e2e
npx playwright test tests/server.spec.mjs
```

The fixture renders the server's actual GOST and HAProxy templates and invokes its exporter for MegaProxy JSON, FoxyProxy JSON, ProxyList and SuperProxy. A test CA replaces ACME issuance; browser certificate exceptions are confined to isolated test profiles. The GOST chain validates the exit certificate against that CA. These are client interoperability tests, not Ansible provisioning or ACME renewal tests. SSH/SSH_JUMP profiles and unsafe self-signed-certificate flags are checked for rejection because the extension cannot implement SSH forwarding.

The native proxy credential dialog is outside Playwright’s page API: tests verify that the browser opens a knock tab and the real server challenges it, but do not automate typing into that dialog.

Server tests record `network-start` before browser requests and `network-end` before
removing their containers, on success or failure. Both timestamped snapshots appear
in the CI log and as separate Playwright attachments for comparison.
When available, `ip` (iproute2) reports addresses, IPv6 `tentative`/`dadfailed` flags,
all routing tables and policy rules; `ss` reports TCP sockets and a socket summary.
Linux runners also inspect each test container's network namespace through
`sudo -n nsenter`, using host tools without modifying container images.
Missing tools or permissions are recorded and do not replace the original test failure.

### Firefox Android integration tests

The separate **Firefox Android tests (optional)** GitHub Actions check runs on PRs,
pushes to `main`, and manual dispatch. It is intentionally not a required merge
check. It uses an accelerated Android 15 / API 35 x86_64 emulator and pinned Firefox
157.0 from Mozilla's APK archive.

The workflow caches a clean, booted AVD snapshot before installing Firefox or the
extension. Cache keys include the emulator and system-image revisions and the AVD
workflow configuration. Test runs restore the snapshot without saving changes;
the current Firefox APK and extension build are installed afresh. A failed test
does not prevent the clean snapshot from being cached.

`npm run test:android` requires a running, root-capable **disposable emulator**,
`adb`, `zip`, a built `dist/firefox`, and `.cache/firefox-android.apk`. Override the
APK path with `FIREFOX_ANDROID_APK`, the adb binary with `ADB`, and the device serial
with `ANDROID_SERIAL` (default `emulator-5554`). Do not run it against a personal
device: the test clears Firefox app data, seeds test preferences and grants the
extension private-window access. A test-only bridge is added to an isolated extension copy, never to release
archives.

The tests exercise saved HTTP proxy authentication, manual domain rules and
subdomains, tab routing with a third-party resource, Direct/System modes, and
responsive popup/options pages in real Firefox Android. Screenshots, request
records and logcat are uploaded as `firefox-android-results`. HTTPS/SOCKS proxies,
unsaved-credential dialogs and the complete mobile feature set are not covered by
this smoke test.

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

We deliberately retain one global active profile. SOCKS/QUIC, user PAC files,
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

## Direct, System and network monitoring

Automatic list downloads run only when an active proxy uses selected lists in the
current routing mode and automatic updates are enabled. Other connection/routing
modes stop the background list alarm and make no subscription requests. Expanding
Routing mode in Settings refreshes a missing or stale catalog and, if currently
used, selected list contents. Fresh cached data makes no requests. Downloads exclude
list sources belonging to inactive routing modes. Manual list updates remain available.

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

The network monitor in Settings lists recent HTTP(S) resources, optionally
filtered to failures (network errors or HTTP status >= 400). Select failed
domains and add them to the active manual domain list or Firefox tab-site list.
The action is hidden in other routing modes and does not switch modes. Data stays in memory and is never sent
anywhere. Only hostname, resource type, status/error, selected profile and time
are retained, without URL paths, query strings, headers, bodies or credentials.
Limits are 200 rows per tab and 50 tabs. Navigation, tab close, opt-out and
background restart clear their relevant entries. The journal has no per-request
storage writes, UI messages or badge changes. Refresh runs every five seconds
only while the monitor is open and visible.

## ZeroOmega import compatibility

Import accepts ZeroOmega/SwitchyOmega settings JSON (`schemaVersion` 1 or 2,
`+name` profiles), from files or the existing config URL importer. It transfers
compatible HTTP/HTTPS fixed profiles, credentials, simple hostname bypasses,
virtual-profile references and a selected switch profile's hostname rules.
`*.example.com` becomes an apex-and-subdomains domain rule; exact hostnames remain
exact. Per-domain profile choices are not imported and produce a review warning. Imported settings never activate a profile.
A knock host is optional.

SOCKS, user PAC, downloaded rule lists, regex/full-URL/time conditions, unequal
per-protocol endpoints or credentials, multiple switch trees and incompatible
rule ordering produce review warnings or skipped profiles. A fixed switch
default cannot activate a local connection automatically and is warned about.
Unsupported settings are not retained. Arbitrary subscription URLs, user PAC
scripts and a separate startup-profile selector remain deliberately out of scope.

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

Until the updated schema is published in MegaProxyConfig, `renew-config-schema`
applies the dynamic-ID and routing-strategy additions from `scripts/config-schema-overrides.mjs`.
`schema-lock.json` records both original upstream and effective local checksums.
The matching schema and English contract documentation are prepared in the local
MegaProxyConfig checkout.

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
