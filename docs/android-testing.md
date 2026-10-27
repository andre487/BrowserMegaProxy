# Firefox Android automation

The suite is `tests/android/firefox.test.mjs`. See [test setup and coverage](testing.md#firefox-android-integration-tests)
for prerequisites and [CI reports](testing.md#where-to-find-reports-in-github) for results.
CI pins Firefox 157.0 on a disposable Android 15 / API 35 emulator.

## Running locally

Build with `npm ci && npm run build`, start a root-capable disposable Google APIs
emulator, and provide the matching Firefox APK:

```sh
ADB="$ANDROID_HOME/platform-tools/adb" \
ANDROID_SERIAL=emulator-5554 \
FIREFOX_ANDROID_APK=/path/to/firefox.apk \
npm run test:android
```

Use an emulator with the APK's ABI. The test refuses physical devices and clears
Firefox app data. It seeds debugging preferences and private-window permission,
installs an isolated test extension, and removes ADB mappings during teardown.
Never use a personal browser profile for this suite.

## How automation works

Mozilla's remote-debugging protocol (RDP) installs the temporary extension. A
local test bridge invokes production message handlers; HTTP fixtures verify actual
proxy traffic. UI Automator opens the native extension popup and settings. The
bridge and test preferences are excluded from release packages.

The suite uses neither geckodriver nor Appium. Desktop viewport emulation cannot
verify Android extension APIs or the native popup. The package uses its main app
profile, which is why this test requires a disposable emulator.

## Startup and failure diagnosis

| Symptom                                           | Check                                                                                                                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Onboarding or default-browser screen blocks setup | Launch the resolved Activity with the documented `automationtest` intent; keep prompt preferences matched to the pinned APK.                                                 |
| Debugger socket is missing                        | Verify Android ADB debugging, Fenix's USB-debug preference and Gecko debug preferences. Open the local HTTP startup tab; the home screen alone does not establish readiness. |
| Socket exists but RDP times out                   | Read the console error and logcat. A socket does not prove that addon installation or its watcher completed. Responses have a 30-second budget.                              |
| Installed event page does not start               | The installer watches and reloads the temporary add-on through RDP before using the bridge.                                                                                  |
| Preferences or extension files are unreadable     | Check app UID/GID and SELinux metadata after pushing files. Setup disables the app while preparing private preferences.                                                      |
| Fixture requests cannot reach the host            | Check the explicit ADB serial and reverse-port mappings. Host localhost is not Android localhost.                                                                            |
| Restored emulator crashes or hangs                | Compare with a cold boot. Check KVM, emulator/system-image revisions and software-rendering logs. A cache hit does not establish emulator health.                            |

For setup failures, start with the console text: JUnit may show every scenario as
canceled while omitting the underlying setup error. The artifact includes logcat,
screenshots and `startup-debug.json` with selected preferences, sockets and file
ownership. A missing `prefs.js` entry alone does not prove the runtime preference;
GeckoRuntime can supply it separately.

The workflow caches a clean boot before installing Firefox, includes emulator/image
revisions in the cache key, and runs with `-no-snapshot-save`. Only the unused Pixel
Launcher ANR is handled specially; Firefox ANRs and failed assertions remain failures.
Inspect startup evidence before increasing timeouts or rerunning a failed setup.

## Limits and references

This is a smoke test of one browser release and emulator configuration. Coverage
and omissions are listed in [testing.md](testing.md#firefox-android-integration-tests);
it does not establish physical-device performance or support for every Android release.

- [Mozilla's Android extension development guide](https://extensionworkshop.com/documentation/develop/developing-extensions-for-firefox-for-android/): temporary extension loading and open-tab requirement.
- [GeckoView automation](https://firefox-source-docs.mozilla.org/mobile/android/geckoview/consumer/automation.html): launch and debugging configuration.
- [Firefox 157 automated launch](https://hg.mozilla.org/releases/mozilla-release/file/FIREFOX_157_0_RELEASE/mobile/android/fenix/app/src/main/java/org/mozilla/fenix/automation/AutomatedLaunch.kt): pinned startup behavior.
- [Android snapshot troubleshooting](https://developer.android.com/studio/run/emulator-snapshots): restore and rendering limitations.
