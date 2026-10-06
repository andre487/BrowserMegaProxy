# Firefox Android automation

Reviewed on 2026-10-06 for Firefox 157.0 and Android 15 / API 35.
This is a review of relevant documented problems, not a guarantee that every
device or Firefox release is covered.

The sequential Node test suite is `tests/android/firefox.test.mjs`. See
[local prerequisites, coverage and CI reports](testing.md#firefox-android-integration-tests)
for how to run it, and [report navigation](testing.md#where-to-find-reports-in-github)
for where to inspect results.

## Supported approaches

For web applications, use Selenium/WebDriver with geckodriver on the host and
Firefox on an ADB-connected device or emulator. Set
`moz:firefoxOptions.androidPackage` and, when needed,
`androidDeviceSerial`. Appium's Gecko driver wraps geckodriver; Appium's
UiAutomator2 driver handles Android-native controls.

For extensions, Mozilla also supports `web-ext run -t firefox-android` through
Firefox's remote-debugging protocol. MegaProxy uses this protocol to install a
temporary test add-on, local HTTP fixtures to verify actual proxy requests, and
Android UI Automator for the native extension action. It does not run geckodriver.

Sources: [Firefox capabilities](https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/Capabilities/firefoxOptions#android),
[Appium Gecko driver](https://github.com/appium/appium-geckodriver),
[Mozilla extension development guide](https://extensionworkshop.com/documentation/develop/developing-extensions-for-firefox-for-android/).

## Startup and environment checklist

| Issue                                                                     | MegaProxy handling                                                                                                          |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Firefox 153+ onboarding can block automation                              | Launch with VIEW, `about:blank`, and `--ez automationtest true`. This is Mozilla's documented workaround.                   |
| Automation intent requires Android ADB debugging to be enabled            | Explicitly set `adb_enabled=1` on the disposable emulator.                                                                  |
| VIEW/about:blank may not resolve through the package's URL intent filters | Resolve the installed launcher Activity and explicitly select it with `am start -n`.                                        |
| Repeated onboarding/default-browser prompts                               | Seed the pinned version's continuous-onboarding and prompt preferences before launch.                                       |
| Root/private profile permissions                                          | Refuse physical devices; restore the profile owner's UID/GID after pushing preference files.                                |
| Background services restart the process during preference setup           | Disable the package while writing private preferences, then re-enable it before the explicit launch.                        |
| Wrong device/package                                                      | Select the emulator serial explicitly and use release package `org.mozilla.firefox`.                                        |
| Remote-debugging connection                                               | Enable the Fenix USB-debug preference and Gecko debug preferences; wait for the abstract socket and forward it through ADB. |
| Fenix home screen does not establish debugger readiness                   | Open a real local HTTP tab through the web intent Activity before discovering the debugger socket.                          |
| Cold-start debugger delays                                                | Allow up to 30 seconds for an RDP response.                                                                                 |
| Host localhost is not Android localhost                                   | Use `adb reverse` for local fixtures and remove mappings during teardown.                                                   |
| MV3 background event page is stopped                                      | Watch and reload the installed add-on through RDP before using the test bridge.                                             |
| Missing private-window permission                                         | Seed permission explicitly; Android proxy support requires it.                                                              |
| Snapshot changes leaking between runs                                     | Cache before installing Firefox/extensions; restore with `-no-snapshot-save`; clear Firefox app data for each run.          |
| Snapshot incompatibility                                                  | Include emulator/system-image revisions and workflow configuration in the cache key.                                        |
| Pixel Launcher ANR after restoring the Google APIs image                  | Disable this unused package only inside the disposable emulator. Firefox ANRs remain test failures.                         |
| CPU/GPU acceleration                                                      | Check KVM and use software rendering on Ubuntu; match the APK ABI to x86_64.                                                |
| Native UI transitions                                                     | Poll for controls instead of assuming fixed animation timing.                                                               |
| Failure diagnostics                                                       | Upload screenshots, synthetic request records and logcat.                                                                   |

Primary references:
[geckodriver 0.37.1 release notes](https://github.com/mozilla/geckodriver/releases/tag/v0.37.1),
[Firefox 157 automated launch implementation](https://hg.mozilla.org/releases/mozilla-release/file/FIREFOX_157_0_RELEASE/mobile/android/fenix/app/src/main/java/org/mozilla/fenix/automation/AutomatedLaunch.kt),
[Firefox 157 engine configuration](https://hg.mozilla.org/releases/mozilla-release/file/FIREFOX_157_0_RELEASE/mobile/android/fenix/app/src/main/java/org/mozilla/fenix/components/Core.kt),
[GeckoView automation configuration](https://firefox-source-docs.mozilla.org/mobile/android/geckoview/consumer/automation.html),
[Android emulator runner](https://github.com/ReactiveCircus/android-emulator-runner).

## Community reports and applicability

- [Stack Overflow: Firefox mobile automation](https://stackoverflow.com/questions/46771456/how-to-automate-firefox-mobile-with-selenium)
  contains old unsupported/mobile-emulation suggestions. Desktop user-agent and
  viewport emulation cannot exercise Android extension APIs or the native action.
- [Stack Overflow: launching Firefox on Android](https://stackoverflow.com/questions/61705772/how-do-i-launch-firefox-on-android-device-for-my-automation-test-cases)
  discusses package/Activity selection and Appium's Gecko driver. Resolve the
  installed Activity rather than copying a historical name.
- [geckodriver #2092](https://github.com/mozilla/geckodriver/issues/2092)
  reports permission errors creating test files on an emulator. Check profile
  location and ownership rather than applying blanket chmod permissions.
- [geckodriver #1922](https://github.com/mozilla/geckodriver/issues/1922)
  reports unsupported attachment to an existing Android session. Our test starts
  a fresh Firefox session and does not rely on `--connect-existing`.
- [Bugzilla #1462019](https://bugzilla.mozilla.org/show_bug.cgi?id=1462019)
  explains filesystem-socket access restrictions. Our forward uses an abstract
  socket, not an app-private filesystem socket.
- [Stack Overflow: waiting for the Android browser](https://stackoverflow.com/questions/59807976/remote-debugging-over-usb-with-android-phone-is-stuck-in-waiting-for-browser)
  reports that Android USB debugging alone is insufficient: Firefox must enable
  its own remote-debugging setting. The pinned Fenix source reads
  `pref_key_remote_debugging` when constructing its engine settings.
- [Bugzilla #1561284](https://bugzilla.mozilla.org/show_bug.cgi?id=1561284)
  describes lazy Gecko startup when no tab is open. A running Firefox process or
  visible home screen does not establish debugger readiness. Mozilla's current
  extension development guide also requires at least one open tab for extension
  loading. Our onboarding launch with `about:blank` was insufficient; the test
  now opens its own local startup page before connecting RDP.
- [Stack Overflow: Android debugger port forwarding](https://stackoverflow.com/questions/73889657/firefox-android-remote-debugger-port-forwarding-fails)
  reports a connection timeout but has no accepted solution. Do not treat it as
  evidence that our failure is the same Mozilla bug. A host ADB forward still
  needs a listening device socket and a valid RDP greeting.
- [emulator runner #342](https://github.com/ReactiveCircus/android-emulator-runner/issues/342)
  reports hangs around snapshot creation/termination on macOS. This is not proof
  of our Ubuntu failure; preserve evidence and check restored versus cold boots.

The ADB restart race is also described in [Chromium's Android test fix](https://chromium.googlesource.com/chromiumos/platform/tast-tests/+/31a834f27ed1550110c7ddd5547f9b4100f070a3).

For startup failures, `startup-debug.json` records only the selected debugging
preferences, debugger socket lines, and preference-file ownership/SELinux
metadata. A missing value in `prefs.js` alone does not prove the runtime value:
GeckoRuntime settings can supply preferences independently of that file.
A listening socket does not prove that add-on installation completed. If the
RDP install request times out, inspect the console report and logcat alongside
these startup diagnostics before changing timeouts.

## Comparison with Mozilla's launchers

The [web-ext Android runner](https://github.com/mozilla/web-ext/blob/master/src/extension-runners/firefox-android.js)
and [ADB implementation](https://github.com/mozilla/web-ext/blob/master/src/util/adb.js)
force-stop the selected browser, launch its Activity, discover the actual Unix
socket, select abstract versus filesystem forwarding, then install through RDP.
Their default socket discovery budget is three minutes. Fenix ignores their
temporary `-profile` launch argument and runs on its main profile, so merely
replacing our launcher with `web-ext` does not configure Fenix's USB-debug setting
or guarantee an open tab. We keep the same RDP installation approach and make
those two prerequisites explicit on the disposable emulator.

For website automation, geckodriver creates and configures a test profile before
launching Firefox and waits for Marionette. Its
[automation preferences](https://firefox-source-docs.mozilla.org/testing/geckodriver/Profiles.html#automation-preferences)
cover more than a debugger port. These are separate from the RDP connection used
to install our extension; setting WebDriver capabilities on an RDP client has no
effect. A move to WebDriver would require adapting our extension test bridge and
retaining a native Android UI driver for the toolbar action.

## Remaining limits

Android documents that snapshots can be unreliable with software rendering and
that restoring them is memory-intensive. Our CI uses software rendering because
it has no hardware GPU; therefore cache hits alone do not prove a healthy emulator.
Investigate crashes with a cold boot before blaming the extension. We retain
snapshot caching as requested and do not silently retry failed assertions.
[Android snapshot troubleshooting](https://developer.android.com/studio/run/emulator-snapshots).

The required CI job tests one pinned Firefox release and one Android/API/device
configuration. It verifies authenticated HTTP proxying, domain/subdomain rules,
tab routing, Direct/System and actual native popup/settings sizing. It does not
prove HTTPS/SOCKS, all Android releases, permission onboarding, offline behavior,
physical-device performance or every extension feature.

A future geckodriver migration should use 0.37.1 or later: 0.37.0 has a documented
non-rooted Android startup regression. GeckoView YAML configuration on a release
APK requires marking the package as the Android debug app. Neither geckodriver
flags nor desktop enterprise policies automatically configure Fenix's native UI.
