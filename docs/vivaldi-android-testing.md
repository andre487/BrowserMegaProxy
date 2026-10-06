# Chromium extension tests on Android (Vivaldi)

Reviewed on 2026-10-06 for Vivaldi 8.2.4147.130, Chromium 152 and Android 15 / API 35.
This check uses an installed Android APK, not desktop viewport emulation.

## Automation approach

Vivaldi documents Android extension installation through the Chrome Web Store or
Developer Mode / Load unpacked. Store installation requires Desktop Site mode;
our local build does not use the store. Tests preserve the complete production
Chromium build, including its Manifest V3 service worker and locale directories.

We use the already-installed Playwright client over Chromium's Chrome DevTools
Protocol (CDP), forwarded through ADB. ChromeDriver documents Android package and
serial selection, but Vivaldi's CDP version reports the Vivaldi release number,
while its user agent identifies the Chromium engine. Direct CDP avoids needing a
ChromeDriver matched to the fork's engine version. This does not imply identical
API support across all Chromium Android browsers.

Sources: [Vivaldi Android extensions](https://help.vivaldi.com/android/android-tools/extensions-on-android/),
[ChromeDriver Android](https://developer.chrome.com/docs/chromedriver/get-started/android),
[Chrome Android remote debugging](https://developer.chrome.com/docs/devtools/remote-debugging/),
[Chromium Android command-line switches](https://www.chromium.org/developers/how-tos/run-chromium-with-flags/).

## Startup and pitfalls

- Select the ADB serial and resolve the installed package's launcher Activity.
  Use the package's VIEW intent for subsequent web navigation, rather than forcing
  a launcher Activity that might show an internal screen.
- Refuse physical devices. Root is used only to prepare this disposable emulator's
  app-private extension directory. Restore the app's UID/GID and SELinux labels:
  ADB-pushed directories can be unreadable to the browser, producing a misleading
  "Default locale is defined but default data couldn't be loaded" error.
- Write `/data/local/tmp/chrome-command-line` with `_` as the first argument.
  Mark Vivaldi as the Android debug app, force-stop before changing flags, and
  verify the effective arguments on `chrome://version`. `chrome://flags` alone
  does not prove the command line was read.
- `--disable-fre`, `--no-first-run` and `--no-default-browser-check` suppress the
  Chromium first-run flow for this pinned APK. Grant notification permission
  before launch so an Android permission dialog does not cover the native UI.
- Wait for the actual CDP socket and extension worker. Do not rely on a fixed
  startup delay or mistake a WebView debug socket for the browser socket.
- Host loopback is not Android loopback: reverse each local fixture port through
  ADB. Remove forwards, reverse mappings, debug-app selection and flags afterward.
- Keep synthetic credentials only. The HTTPS fixture has a generated one-day
  test certificate; `--ignore-certificate-errors` applies to the disposable test
  browser, not the extension's production configuration.
- Use a Google APIs image, which supports `adb root`, rather than a production
  Google Play image. CI checks KVM and uses an x86_64 APK; Apple Silicon local
  testing uses the arm64-v8a APK.
- Cache the clean AVD before installing Vivaldi or extensions. Include emulator
  and system-image revisions in the cache key and use `-no-snapshot-save` for tests.
  Software-rendered snapshots still need diagnostics; a cache hit is not proof
  that the emulator is healthy.
- Reuse the Firefox workaround for the unused Pixel Launcher ANR. Browser ANRs
  and failed assertions remain failures; no blind dismissal or assertion retries.

Primary references: [Chromium emulator setup](https://chromium.googlesource.com/chromium/src/+/main/docs/android_emulator.md),
[Android emulator snapshots](https://developer.android.com/studio/run/emulator-snapshots),
[Android emulator runner](https://github.com/ReactiveCircus/android-emulator-runner).
See also [Firefox lessons](android-testing.md).

## Community reports

[Stack Overflow: skipping Chrome's welcome page](https://stackoverflow.com/questions/33408138/how-to-skip-welcome-page-in-chrome-using-adb)
describes command-line files, debug-app selection and a full restart. These
instructions are cross-checked against Chromium's current documentation; desktop
flags are not assumed to work on Android without checking the effective command.

[Stack Overflow: Vivaldi and Selenium](https://stackoverflow.com/questions/59644818/how-to-initiate-a-chromium-based-vivaldi-browser-session-using-selenium-and-pyth)
describes desktop binary/driver setup. It does not document Android installation
or extension APIs. Historical claims that Vivaldi Android cannot load extensions
must be checked against the current Vivaldi documentation.

## Running locally

Build with `npm ci && npm run build`, start a root-capable disposable API 35
Google APIs emulator, then run:

```sh
ADB="$ANDROID_HOME/platform-tools/adb" \
ANDROID_SERIAL=emulator-5554 \
VIVALDI_ANDROID_APK=/path/to/Vivaldi.8.2.4147.130_arm64-v8a.apk \
npm run test:android:chromium
```

Download the matching ABI from the [official Vivaldi archive](https://vivaldi.com/download/archive/?platform=android).
If the shell has HTTP(S)/ALL proxy environment variables, configure loopback
exclusions or clear those variables before connecting to the local CDP endpoint.

The separate **Vivaldi Android tests** CI job uses a pinned release and cached
clean API 35 emulator. Evidence is uploaded as `vivaldi-android-results`.
Coverage is a focused smoke test: authenticated HTTP proxying, HTTPS knock
success/closure, domain/subdomain rules, Direct/System and mobile extension UI. Native popup geometry is measured through
its CDP target: Android API metadata alone does not reliably identify its surface.
Popup content must not use its initially tiny viewport as a maximum height.
It does not prove all Vivaldi/Android releases, SOCKS or every extension feature.
