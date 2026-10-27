# Developing MegaProxy

Build requirements and contributor commands for this repository.
See [test runners, reports and emulator checks](testing.md) for test setup.

## Build and install locally

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
See [mobile test coverage and limitations](testing.md).

Each PR's separate **Installation archives** workflow publishes two ZIP artifacts:
**MegaProxy-chromium** and **MegaProxy-firefox**. Open the run from the PR checks,
download the archive from **Artifacts**, and extract it. Its `manifest.json` is at the
archive root; install the extracted directory as described above.
Artifacts are retained for 14 days. The archive workflow and PR-description update
finish independently of browser tests.
The latest archive links are maintained at the bottom of the PR description,
including release PRs that merge before the publication job starts.

## Development launcher

Install a current regular Google Chrome and/or Firefox. macOS, Linux and Windows
are supported; Node.js 22+ and `npm ci` are required.

```sh
npm start             # Chrome by default
npm start --chrome    # Chrome
npm start --firefox   # Firefox
npm start -- --watch  # Chrome with automatic rebuilds
npm start -- --clear  # Chrome with a clean development profile
npm start -- --light  # Chrome with a light browser theme
npm start -- --dark   # Chrome with a dark browser theme
npm start -- --firefox --dark # Firefox with a dark browser theme
npm start -- --firefox --clear # Firefox with a clean development profile
npm start -- --firefox --watch # Firefox with automatic rebuilds
```

Some npm versions warn about unknown flags. The portable argument syntax is
`npm start -- --chrome` and `npm start -- --firefox`.

`--clear` deletes the selected development browser profile before launching, including
extension settings, cookies, and browsing history. Close the browser using that profile
first. The other browser profile is kept. Combine it with `--watch` to rebuild automatically.

`--watch` monitors `extension/` and `scripts/build.mjs`: changes rebuild and reload
the extension without restarting the browser. Settings are preserved.
Chrome also refreshes open extension tabs; Firefox extension pages may need to be
reopened. Build errors appear in the terminal; watching continues until the next change.

`--light` and `--dark` set the browser theme independently of the operating system.
Choose one; they work with either browser and combine with `--clear` and `--watch`.
The selected theme is saved in the development profile. Without either flag, the
launcher keeps the existing theme. MegaProxy's own theme is controlled in its settings.

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

The six required checks are lint, unit tests, Chromium, Firefox, Firefox Android
and Vivaldi Android. See [test commands, coverage and reports](testing.md) for setup
and failure diagnostics. Desktop checks run on every PR and push to `main`.

## Code organization

UI translations live in `extension/_locales/{en,ru}/messages.json`; runtime language
selection is separate from the browser's localized extension description.

`extension/platform.js` contains the shared `BrowserPlatform` class and its
`ChromiumPlatform` and `FirefoxPlatform` implementations. They handle native proxy
settings, authentication and knock, tab routing, available UI capabilities and
import compatibility. The concrete implementation is selected at startup; shared
handlers and UI call its methods.

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
MegaProxy branding has one source: [MegaProxyIdentity](https://github.com/andre487/MegaProxyIdentity)
(CC0-1.0). `extension/icons/identity-lock.json` records the upstream commit and
SHA-256 checksums; downloaded SVGs and the license are stored unchanged alongside it.
Do not edit these files or generated PNGs locally.
Previous BrowserMegaProxy icons are archived in
[MegaProxyIdentity/Generative/BrowserMegaProxy](https://github.com/andre487/MegaProxyIdentity/tree/main/Generative/BrowserMegaProxy)
with their original license.

```sh
npm run renew-identity                    # download latest main and generate PNGs
npm run renew-identity -- --ref=<commit>   # use a specific upstream revision
```

`SVG/icon-radius.svg` supplies UI logos and large extension icons;
`SVG/icon-toolbar.svg` supplies toolbar icons and the 16/32 px extension icons;
`SVG/shop-icon.svg` supplies the shared store icon;
`SVG/chrome-promo-little.svg` and `SVG/chrome-promo-big.svg` supply the store
promotional images; `SVG/social-preview.svg` supplies the repository social preview.
`SVG/feature-graphic.svg` is retained in the upstream snapshot but is not rendered
by the current branding generator.
`npm run build` uses the checked-in assets without network access.
`node scripts/renew-toolbar-icons.mjs` verifies source checksums and regenerates
all branding PNGs offline using the installed Sharp dependency.
Screenshots remain generated from the real UI by `npm run store:assets`.
The official Google/Mozilla installation badges in `docs/assets` are third-party
marks, not MegaProxy identity assets.

## Configuration schema maintenance

The build generates a CSP-compatible validator from the local schema: version 8
imports and exports use the same schema as the tests. Builds and tests never fetch schemas.

```sh
npm run renew-config-schema
npm run renew-config-schema -- --ref=<full-commit>
```

This command updates `config-schema/`: both schemas, the license, commit and SHA-256
values in the lock file. Review and commit schema copies and the lock file together.
The formatter excludes this directory to preserve original bytes and checksums.
Both schemas are vendored unchanged from MegaProxyConfig; the lock file records
their upstream checksums. Browser additions are defined in that shared contract.

## HTTP failure diagnostics

Release APIs, schema/catalog renewal and extension downloads share bounded HTTP
5xx diagnostics. The handler reads at most 16 KiB and emits at most 4,096 characters,
redacting known credentials, authorization fields, URLs and control characters.
Empty or unreadable bodies are marked; HTTP 4xx bodies are not logged. Server text
can still contain other data, so review exported diagnostics before sharing them.

Release and maintenance API calls and extension configuration downloads retry 5xx
up to three total attempts, with 1 and 2 second delays, logging each excerpt.
Connection checks do not retry a failed endpoint, but can try fallback lookup services.
HTTP 4xx and transport failures are not retried by this shared handler.

Extension response excerpts survive error wrapping and can appear in the UI and
local diagnostic log. Checks read diagnostic error-page text when accessible;
background downloads read their responses directly. The network monitor gets status
codes from webRequest events and does not replay requests to obtain response bodies.
