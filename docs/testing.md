# Testing MegaProxy

See [development setup](development.md) for installation and linting.

## Test runners and reports

`npm test` runs unit tests with Node's built-in test runner. Android suites use
the same runner in `tests/android/*.test.mjs`, with named sequential scenarios,
one browser setup per suite, and teardown that also runs after a failure.
Scenario failures do not prevent the remaining scenarios from running; a failed
setup prevents the suite from proceeding. Desktop browser tests use Playwright Test.

All runners print named results and write JUnit XML under `test-results/`:
`unit.xml`, `android-firefox.xml`, `android-vivaldi.xml`, or `playwright.xml`.
Node suites also retain a text report with setup/teardown errors that their
JUnit reporter may omit.
Extra Node runner flags can be passed through npm, for example
`npm test -- --test-name-pattern=knock`.
Playwright also writes an HTML report; open it with `npx playwright show-report`.

Each GitHub Actions test job publishes a summary with counts and expandable
results, even after failures. JUnit reports and browser evidence are retained
as artifacts for seven days. Playwright failures also create GitHub annotations.
These reports do not change the separate required test statuses.

### Where to find reports in GitHub

From a PR, open **Checks → the test check → Details**, then select **Summary**
in the workflow's left sidebar. Scroll below the workflow graph and **Artifacts**
to the job summaries. Expand the test results to see scenario names and failures.
Opening an individual job shows its step logs, not the rendered test report.
Android checks have separate workflow runs and their own summaries.

Download artifacts from the same Summary page while signed in:

| Check                 | Report artifact              | Contents                                       |
| --------------------- | ---------------------------- | ---------------------------------------------- |
| Unit tests            | `unit-test-report`           | JUnit XML and console text                     |
| Chromium tests        | `playwright-report-chromium` | HTML report, JUnit XML, traces and attachments |
| Firefox tests         | `playwright-report-firefox`  | HTML report, JUnit XML, traces and attachments |
| Firefox Android tests | `firefox-android-results`    | JUnit XML, console text and emulator evidence  |
| Vivaldi Android tests | `vivaldi-android-results`    | JUnit XML, console text and emulator evidence  |

Extract a desktop artifact and open its `playwright-report` directory with
`npx playwright show-report /path/to/playwright-report`. Open a failed test's
trace from that report, or use `npx playwright show-trace /path/to/trace.zip`.
For an Android setup failure, read the console text and startup/logcat evidence:
the JUnit reporter may mark scenarios canceled without including the setup error.
If a job fails before tests start, use its step logs; a test report may not exist.

### Local commands

Run `npm ci && npm run build` first. Unit tests also need `zip`, `unzip` and a POSIX
shell for the Firefox publication CLI check; they do not need browsers or Docker.
Desktop E2E tests additionally need installed Playwright browsers, Docker with a running daemon,
uv, Git, OpenSSL and tar. The full desktop suite currently runs on macOS or Linux:
the GOST preparation script has no Windows binary configuration. This does not
restrict the Windows development launcher. Android suites require the emulator
setup described below.

| Command                                  | Scope                                                          |
| ---------------------------------------- | -------------------------------------------------------------- |
| `npm test`                               | Unit tests                                                     |
| `npm run test:e2e -- --project=chromium` | Desktop Chromium and real-server scenarios                     |
| `npm run test:e2e -- --project=firefox`  | Desktop Firefox and real-server scenarios                      |
| `npm run test:android`                   | Seven Firefox Android smoke scenarios                          |
| `npm run test:android:chromium`          | Nine Vivaldi Android smoke scenarios                           |
| `npm run check`                          | Lint, build, units and both desktop projects; excludes Android |

## Configuration subscriptions and notices

Configuration-subscription tests in `features.test.mjs` use controlled downloads
and browser API mocks to cover Basic Auth, source failover, replacement of a removed
profile, Direct/System preservation, rollback and changed active-profile/Podkop rules.
UI tests cover **Update now** while paused, notice acknowledgment and notification
permission refusal. Installed-extension feature tests check the toolbar notice and
its dismissal in both desktop browsers. Native operating-system notification delivery
and the complete mobile subscription flow are not automated.

## Server integration tests

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

## Firefox Android integration tests

See [Android automation notes](android-testing.md) for launch requirements,
known upstream problems and test limitations.

The separate **Firefox Android tests** GitHub Actions check runs on PRs,
pushes to `main`, and manual dispatch. It is required for merging and releases.
It uses an accelerated Android 15 / API 35 x86_64 emulator and pinned Firefox
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
extension private-window access. It launches Firefox with Mozilla's documented `automationtest` intent,
explicitly resolving the launcher Activity, and disables repeated onboarding and
default-browser prompts. Native UI automation is reserved for the extension's
action popup and settings. A test-only bridge is added to an isolated extension copy, never to release
archives.

The tests exercise saved HTTP proxy authentication, manual domain rules and
subdomains, tab routing with a third-party resource, Direct/System modes, and
responsive popup/options pages in real Firefox Android. Opening Settings must
replace the action popup without pressing Back or manually selecting its tab.
Screenshots, request records and logcat are uploaded as `firefox-android-results`. HTTPS/SOCKS proxies,
unsaved-credential dialogs and the complete mobile feature set are not covered by
this smoke test.

## Chromium Android integration tests (Vivaldi)

The separate **Vivaldi Android tests** check runs the production Chromium build
in pinned Vivaldi 8.2.4147.130 on an accelerated API 35 x86_64 emulator, with a
cached clean snapshot. It is required for merging and releases. It exercises saved HTTP proxy authentication, HTTPS knock
success and failure, manual domain/subdomain routing, Direct/System and the native
extension popup/settings. Screenshots, network snapshots and logcat are uploaded
as `vivaldi-android-results`.

`npm run test:android:chromium` needs a disposable root-capable emulator, `adb`,
`openssl`, a built `dist/chromium` and `.cache/vivaldi-android.apk`. Override the APK
with `VIVALDI_ANDROID_APK`, the adb binary with `ADB` and the serial with
`ANDROID_SERIAL`. See [Vivaldi Android automation notes](vivaldi-android-testing.md)
for official documentation, community reports, local commands and limitations.
