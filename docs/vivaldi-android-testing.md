# Chromium extension tests on Android (Vivaldi)

The suite is `tests/android/vivaldi.test.mjs`. CI pins Vivaldi 8.2.4147.130 on a
disposable Android 15 / API 35 emulator. See [test coverage](testing.md#chromium-android-integration-tests-vivaldi)
and [CI reports](testing.md#where-to-find-reports-in-github).

## Running locally

Build with `npm ci && npm run build`, start a root-capable disposable API 35
Google APIs emulator, then run with an APK matching its ABI:

```sh
ADB="$ANDROID_HOME/platform-tools/adb" \
ANDROID_SERIAL=emulator-5554 \
VIVALDI_ANDROID_APK=/path/to/vivaldi.apk \
npm run test:android:chromium
```

Download from the [official Vivaldi archive](https://vivaldi.com/download/archive/?platform=android).
CI uses x86_64; Apple Silicon emulators use arm64-v8a. Physical devices are refused:
the test clears app data and prepares app-private extension files as root.

## How automation works

The test loads the complete production Chromium build, including its Manifest V3
worker and locales. Playwright connects over CDP forwarded through ADB; no matched
ChromeDriver is needed. Android UI automation opens the native popup and settings.
Local HTTP/HTTPS fixtures verify proxy requests and knock-tab behavior.

## Startup and failure diagnosis

| Symptom                                        | Check                                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vivaldi does not launch or navigate            | Select the ADB serial, resolve the installed launcher Activity, and use VIEW intents for later navigation.                                              |
| Extension reports missing locale data          | Restore the app's UID/GID and SELinux labels after pushing files. Preserve the packaged `_locales` directory.                                           |
| Startup flags have no effect                   | Write `/data/local/tmp/chrome-command-line` with `_` first, select Vivaldi as the Android debug app and restart it. Verify flags on `chrome://version`. |
| CDP connection fails                           | Wait for the browser's actual socket and extension worker. Exclude loopback from shell proxy variables; do not attach to a WebView socket.              |
| Fixtures cannot reach the host                 | Check ADB reverse mappings for every fixture port.                                                                                                      |
| Popup or a permission dialog obscures settings | Inspect screenshots and the native hierarchy. Opening Settings must close the action popup; the test does not press Back to hide it.                    |
| Knock events appear inconsistent               | Inspect `browser-events.json` by tab creation ID. A new tab's URL may not yet be updated. The fixture disables caching.                                 |
| Snapshot restore hangs                         | Compare a cold boot, KVM and software-rendering logs. Cache only a clean pre-install AVD and run with `-no-snapshot-save`.                              |

Test certificates and `--ignore-certificate-errors` are confined to the disposable
browser. They do not change production certificate validation. Cleanup removes ADB
mappings, debug-app selection and command-line flags. Browser ANRs and failed
assertions remain failures; the unused Pixel Launcher ANR has the same limited
workaround as [Firefox Android](android-testing.md).

Evidence includes screenshots, requests, network snapshots, browser events and
logcat. Popup geometry is measured through its CDP target: Android metadata alone
does not reliably identify the surface. This smoke suite does not establish support
for every Chromium Android fork; see the [coverage limits](testing.md#chromium-android-integration-tests-vivaldi).

## References

- [Vivaldi Android extensions](https://help.vivaldi.com/android/android-tools/extensions-on-android/): supported installation methods.
- [Chromium Android command-line switches](https://www.chromium.org/developers/how-tos/run-chromium-with-flags/): debug-app selection and flags.
- [Chrome Android remote debugging](https://developer.chrome.com/docs/devtools/remote-debugging/): ADB/CDP access.
- [Android emulator snapshots](https://developer.android.com/studio/run/emulator-snapshots): restore limitations.
