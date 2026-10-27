# MegaProxy

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/andre487/BrowserMegaProxy)](https://github.com/andre487/BrowserMegaProxy/releases/latest)
[![Chromium 120+](https://img.shields.io/badge/Chromium-120%2B-4285F4?logo=googlechrome&logoColor=white)](#build-and-install)
[![Firefox 140+](https://img.shields.io/badge/Firefox-140%2B-FF7139?logo=firefoxbrowser&logoColor=white)](#build-and-install)

[![CI](https://github.com/andre487/BrowserMegaProxy/actions/workflows/pr.yml/badge.svg?branch=main&event=push)](https://github.com/andre487/BrowserMegaProxy/actions/workflows/pr.yml?query=branch%3Amain+event%3Apush)
[![Firefox Android](https://github.com/andre487/BrowserMegaProxy/actions/workflows/android-firefox.yml/badge.svg?branch=main&event=push)](https://github.com/andre487/BrowserMegaProxy/actions/workflows/android-firefox.yml?query=branch%3Amain+event%3Apush)
[![Vivaldi Android](https://github.com/andre487/BrowserMegaProxy/actions/workflows/android-vivaldi.yml/badge.svg?branch=main&event=push)](https://github.com/andre487/BrowserMegaProxy/actions/workflows/android-vivaldi.yml?query=branch%3Amain+event%3Apush)

<p align="center">
  <img src="extension/icons/icon-radius.svg" width="160" alt="MegaProxy extension icon">
</p>

MegaProxy manages user-provided proxies in Chromium and Firefox: profiles,
authentication, selective routing, configuration subscriptions and connection checks.
It does not provide proxy servers or a VPN service.

[Quick start](#quick-start) · [Browser support](#browser-support) · [Troubleshooting](#troubleshooting) · [Reference](docs/reference.md) · [Privacy](store/PRIVACY.md)

## Build and install

<table>
  <tr><th align="center">Chromium</th><th align="center">Firefox</th></tr>
  <tr>
    <td align="center"><a href="https://chromewebstore.google.com/detail/megaproxy/kfilelfnldddoncicbampiojjjcpbigo"><img src="docs/assets/chrome-web-store.png" alt="Install MegaProxy from the Chrome Web Store" height="60"></a></td>
    <td align="center"><a href="https://addons.mozilla.org/firefox/addon/megaproxy/"><img src="docs/assets/firefox-addons.png" alt="Get MegaProxy for Firefox" height="60"></a></td>
  </tr>
</table>

Use Chromium 120+, Firefox desktop 140+ or Firefox Android 142+.
Firefox requires **Allow in private windows** for proxy control; the selected proxy
also applies there. The Chromium build is tested in Vivaldi Android; ordinary Chrome
Android and Safari cannot load this extension.

For local builds and unsigned PR archives, see [development setup](docs/development.md#build-and-install-locally).
Permanent Firefox installation requires a Mozilla-signed package.

## Quick start

1. Install the package for your browser. In Firefox, allow private-window access in
   the add-on settings.
2. Open MegaProxy's popup → **Settings**. Import a configuration from your provider
   using a file or URL, or choose **Add profile** and enter the protocol, server,
   port and any supplied username/password. **HTTPS** means TLS to the proxy.
3. If the provider supplies a **Knock host**, enter that hostname in the profile's
   advanced fields. Keep it outside the profile's bypass rules.
4. Select the profile in the popup to connect. Imports alone do not connect a profile.
   Keep full proxying initially; configure selective routing after the connection works.
5. Run **Check connection**. Confirm the displayed exit IP, then open a website.
   **Disconnect** returns to System mode; use **Direct** to explicitly bypass proxies.

Settings offers Auto/Russian/English language and light/dark appearance; Firefox also
supports automatic appearance. The popup provides profile selection and quick actions.

## Browser support

| Capability                       | Chromium desktop / Vivaldi Android                                | Firefox desktop / Android                                       |
| -------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------- |
| HTTP and HTTPS proxy             | Yes                                                               | Yes                                                             |
| Saved HTTP/HTTPS credentials     | Supplied after a proxy challenge (407)                            | HTTPS can send them in the first CONNECT; HTTP may wait for 407 |
| Configured knock host            | Automatic on connection/startup, including with saved credentials | Same                                                            |
| SOCKS5                           | Anonymous only; proxy-side DNS                                    | Username/password and proxy-side DNS                            |
| Domain rules and automatic lists | Yes                                                               | Yes                                                             |
| Routing by top-level site/tab    | No                                                                | Yes, including attributed third-party requests                  |
| Experimental MASQUE              | No                                                                | Firefox 146+, opt-in; no username/password                      |
| Private windows                  | Extension access disabled by default                              | Permission required; active settings apply there too            |

Mobile smoke tests cover a subset of these capabilities, not every protocol or device.
See [test coverage](docs/testing.md) and [MASQUE limitations](docs/reference.md#experimental-masque-in-firefox).

## Connection modes and selective routing

- **Proxy:** use the selected profile, subject to routing and bypass rules.
- **Direct:** force direct connections without a proxy.
- **System:** release MegaProxy's control and use browser/system proxy settings.

Full proxying is the default. Selective routing uses the one active profile for
matching requests and connects directly otherwise; it does not choose different
profiles per site or automatically fail over after errors.

For manual destination rules, `example.com` matches only itself, `*.example.com`
matches subdomains, and `**.example.com` matches both. Firefox's **By tabs** mode
also sends a selected tab's attributed third-party requests through the proxy;
bare site names include subdomains. Empty selective lists connect directly.
Local-network bypass is enabled by default; explicit profile exclusions also apply.

**Automatic lists** downloads selected Podkop domain lists. Updates can use the active
proxy. A failed update retains the last successful rules; the 1,000-rule limit can
leave dropped domains connecting directly. See [routing and list details](docs/reference.md#selective-routing).

## Authentication and probe resistance

A **knock host** is an HTTPS website allowed by a masked proxy to trigger an
authentication challenge. Use the hostname supplied by your proxy operator; leave
it empty if your proxy does not need it.

Both browsers open the configured host on connection and startup, in the background
with saved credentials and actively without them. A successful load closes the tab.
Rejected saved credentials can open MegaProxy's correction dialog; without saved
credentials, the browser handles authentication. SOCKS5 and MASQUE do not use knock.
See [authentication details](docs/reference.md#authentication-and-probe-resistance).

## Configuration subscriptions

When importing a URL, enable a subscription to receive future configuration updates.
Settings lets you edit its sources, pause automatic updates, refresh with **Update now**
even while paused, or cancel the subscription while retaining imported profiles.
Failed updates preserve the working configuration. Backup URLs receive the same
configured Basic Auth credentials, so use only trusted sources.

Changed connection settings show a notice in the popup/settings and `!` on the toolbar.
Reload affected pages in Firefox; Chromium can require a browser restart for existing
connections. Optional system notifications require separate consent.
See [subscription behavior and format](docs/reference.md#configuration-subscriptions).

## Configuration compatibility

Imports support MegaProxy JSON, ZeroOmega, FoxyProxy, ProxyList and SuperProxy, with
review warnings for unsupported fields and profiles. Exports use MegaProxy version 8.
HTTP profiles and HTTPS proxies with IPv6 host literals cannot be exported under the
portable contract. Other clients may discard browser-specific settings.
See [import/export compatibility](docs/reference.md#configuration-compatibility).

## Connection checks and privacy

Connection checks show HTTPS loading time, exit IP and optional country in Proxy,
Direct or System mode. They use a temporary background tab and public IP/country
services; loading time is not a ping or speed measurement.

Passwords are stored without separate encryption by MegaProxy. Browser synchronization,
password synchronization and password inclusion in exports are **enabled by default**;
each can be disabled. Request statistics and the network monitor are enabled by
default, remain local and can be disabled together. Diagnostic logs remain local too.

**Delete service requests from history** is off by default and requests optional
history access. It removes knock/check-tab URLs, including earlier visits to those
same URLs. Background IP/country lookups do not create history visits. WebRTC privacy
controls request optional permission, affect the whole browser and can affect calls.
See [privacy](store/PRIVACY.md), [permissions](store/PERMISSIONS.md) and
[settings details](docs/reference.md#webrtc-sync-and-routing-tools).

## Troubleshooting

| Symptom                                        | What to check                                                                                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection fails or appears stuck              | Verify protocol, host and port. For masked proxies, configure the provider's knock host; a hidden challenge can conceal a wrong password.                                                                           |
| Password is rejected                           | Correct it in MegaProxy's authentication dialog. If the original request expired, reload its page. Proxy authentication caches may require a browser restart after switching credentials on the same endpoint.      |
| Certificate error                              | HTTPS is TLS to the proxy. Use a browser-trusted certificate matching its hostname; disabling verification is unsupported.                                                                                          |
| A site connects directly                       | Check Proxy mode, active profile, local/profile bypass and the selected routing strategy. Empty lists or truncated automatic lists can explain it. Use the routing tester; provide a tab URL for Firefox tab rules. |
| Knock tab stays open                           | Check the website's availability, credentials, certificate and server-side knock allowlist. Only a successful load closes it; opening a tab alone does not prove authentication. Retry with **Knock**.              |
| Browser opens an authentication window         | A background knock can request credential correction. Without saved credentials its tab opens actively; successful knock tabs with saved credentials are requested as inactive.                                     |
| Settings changed but a page uses the old route | Existing connections are not migrated. Follow the connection-update notice: reload affected pages or restart Chromium.                                                                                              |
| Connection check fails                         | Check that diagnostic hosts are not bypassed. The overall timeout is 45 seconds; an unavailable country result alone need not fail the check.                                                                       |
| Firefox cannot control the proxy               | Enable private-window access. Check for another extension or policy controlling proxy settings.                                                                                                                     |
| Popup cannot reach the background process      | Inspect extension errors in `chrome://extensions` or `about:debugging`, then reload the extension.                                                                                                                  |

For a [bug report](https://github.com/andre487/BrowserMegaProxy/issues), include browser/OS
versions, reproduction steps and a diagnostic log exported from the Settings footer.
Review the log before sharing; do not attach credentials or sensitive configurations.

## Documentation

| Document                                                            | Purpose                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [Configuration and behavior reference](docs/reference.md)           | Matching rules, authentication, subscriptions, sync, import/export and experimental MASQUE |
| [Development](docs/development.md)                                  | Local builds, browser launcher, formatting and schema/asset maintenance                    |
| [Tests and reports](docs/testing.md)                                | Test commands, prerequisites, CI reports and mobile coverage                               |
| [Release automation](RELEASING.md)                                  | Release preparation, signing, store submission and recovery                                |
| [Store materials](store/README.md)                                  | Listing sources, screenshots and reviewer documents                                        |
| [Privacy](store/PRIVACY.md) and [permissions](store/PERMISSIONS.md) | Data handling and required/optional browser access                                         |
