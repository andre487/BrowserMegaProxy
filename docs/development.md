# Developing MegaProxy

Build requirements and contributor commands for this repository.
See [test runners, reports and emulator checks](testing.md) for test setup.

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
Ctrl+C stops watching and waits for a normal browser shutdown so the profile is saved cleanly.

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
# Requires Docker with a running daemon, uv, Git, OpenSSL, zip/unzip and tar.
npx playwright install chromium firefox
npm run check
```

`npm run check` runs linting, a build, unit tests and desktop browser tests on
macOS or Linux; the GOST test-binary preparation does not support Windows.
Android checks need an emulator and run separately; see [testing](testing.md).

[.github/workflows/pr.yml](../.github/workflows/pr.yml) runs checks on every PR
and push to `main`. Separate workflows run the two required Android suites.
Together they cover:

- ESLint: code quality rules for all JS/MJS files; errors and warnings block the PR.
- Prettier: consistent JS/MJS, HTML/CSS/JSON, Markdown and YAML formatting; differences block the PR.
- Node: validation, Unicode Basic, routing, imports, retry limits and credential protection; configuration-subscription source failover, profile replacement, rollback and connection-update notices.
- Playwright Chromium: installed MV3 extension, a real proxy challenge, knock, subsequent CONNECT and no credentials reaching the origin.
- Playwright Firefox: temporary add-on installation through Mozilla DevTools Protocol; a test-only sidecar in a temporary copy invokes the normal background handler and is excluded from builds. Playwright checks real network requests; controlling `moz-extension` pages is unsupported.
- MegaProxyServer: real GOST 3.3.0 and HAProxy in Docker, templates and exports from a pinned server commit; HTTPS/407, camouflage with and without knock, separate chain camouflage settings, direct and SNI-chain routes (including a server with no direct route), IP endpoints, invalid/empty credentials, no origin credential leaks, exit failure without direct fallback, split proxy, proxied subscriptions, diagnostics and request-statistics preferences.
- Chrome development launcher: current code after relaunch and language persistence in a separate profile, when regular Chrome is installed.
- Chromium and Firefox UI: create/edit/delete, imports, themes, keyboard access and mobile widths; automatic browser-language selection, persisted manual choices, translated errors and form preservation on language changes; manual subscription refresh while paused, connection notices and optional notification consent/refusal.

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
Toolbar icons are separate PNGs with rounded transparent corners at 16, 24, 32,
48 and 64 px. Vector sources are `extension/icons/icon.svg` and
`extension/icons/toolbar.svg`. Regenerate the toolbar PNGs from their vector source
with `node scripts/renew-toolbar-icons.mjs`
(requires installed Playwright Chromium).
