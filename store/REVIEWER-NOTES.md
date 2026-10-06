# Store submission notes

## Single purpose

Manage the browser’s connection through a user-provided HTTP/HTTPS proxy, including authentication, routing rules and diagnostics for that connection. MegaProxy does not sell or supply proxy servers.

## Permissions justification

See [Permission justifications](PERMISSIONS.md) for a separate, ready-to-paste English justification for every requested API permission, host access and optional permission. The document also explains Firefox’s data-collection declaration.

There is no remote executable code. UI scripts and schema validation are packaged locally. Downloaded domain lists and configurations are parsed as data. Browser-generated PAC configuration in Chromium is built from validated settings, not a user-supplied script.

## Review steps

1. Install the browser-specific package. Chromium requires version 120+; Firefox requires 128+ and private-window access for `proxy.settings`.
2. Open settings. Add an HTTP or HTTPS CONNECT proxy you control. Save and select it. Test Proxy, Direct and System, then run a connection check.
3. Expand Routing mode. Test manual domains and subdomain wildcards, rule testing and automatic list selection. Firefox additionally exposes By tabs. Chrome and Opera do not offer tab routing.
4. Test import/export using a non-sensitive MegaProxy configuration. A complete configuration may also be imported from a URL you control.
5. Inspect General preferences: theme, language, WebRTC, synchronization/password synchronization and request monitoring. Disable monitoring and confirm its UI disappears.
6. Open the local diagnostic log from the settings footer; test size limit, clearing and file export.

No MegaProxy account is required. An actual connection test needs a working proxy supplied by the reviewer. Do not treat the illustrative `.example` servers in store screenshots as usable credentials. The repository’s `tests/megaproxy-server` fixtures support real-proxy automated tests; see README for test setup.

## Browser packages

- Chrome Web Store: ZIP containing the contents of `dist/chromium`, with `manifest.json` at its root.
- Firefox Add-ons: ZIP containing the contents of `dist/firefox`. Mozilla signs the store distribution; development/PR archives are unsigned.
- Opera Add-ons: use the Chromium package. Assets and descriptions are prepared for its Chromium UI; a release must also be checked in the target Opera version before submission. Opera-specific runtime testing has not been performed by this asset generator.

Upload the extension package, not the store-materials ZIP. Provide a public URL for the privacy policy after this document is available on the default branch. For example: `https://github.com/andre487/BrowserMegaProxy/blob/main/store/PRIVACY.md`.

For Chrome’s privacy questionnaire, disclose browser synchronization of settings/passwords and user-triggered requests to external services as described in the policy. Do not claim that nothing ever leaves the device. The developer does not collect or sell this data.
