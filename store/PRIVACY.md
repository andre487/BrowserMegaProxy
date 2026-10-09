# MegaProxy privacy policy

Last updated: 6 October 2026.

MegaProxy is an open-source browser extension that manages user-provided proxy settings. It has no developer-operated analytics, advertising, account service or telemetry endpoint. The developer does not receive your browsing history, proxy credentials, request counters or diagnostic logs from the extension.

## Stored data

Proxy profiles, server addresses, usernames, passwords, routing rules and preferences are stored in your browser’s extension storage. Passwords are not separately encrypted by MegaProxy. Configuration exports include passwords by default; you can exclude them before exporting. Exported files remain under your control.

Browser settings synchronization and password synchronization are enabled by default. If browser sync is configured, your browser may transmit these settings, including saved passwords, through its synchronization service. You can disable all synchronization or exclude passwords in MegaProxy settings. The browser vendor’s privacy policy and account settings apply to that service; MegaProxy does not operate it.

Request counters and the network monitor are enabled by default and can be disabled together. The monitor retains up to 200 recent requests per tab and up to 50 tabs in memory. It stores domains, request types, status or error codes and routing information, not URL paths, query parameters or request bodies. Monitor entries are reset when the page navigates or the extension’s background process stops; counters are also not persistent. These records are not synchronized or sent to the developer.

The diagnostic log is stored locally in IndexedDB and rotated according to a configurable 1–10 MiB text limit (3 MiB by default). It records selected extension events and diagnostic fields. HTTP 5xx failures from extension requests may include up to 4,096 characters of server response text; known credentials, authorization fields and URLs are redacted before storage. Server responses may still include other data supplied by that server. Database overhead can exceed the text limit. You can clear the log or export it to a file. Logs are not synchronized or uploaded by MegaProxy.

## Network requests

When a proxy is selected, matching traffic and proxy authentication are sent to the proxy you configured. The proxy operator and destination websites process these requests under their own policies. MegaProxy does not provide or operate your proxy server.

A configured knock host may be opened in a background tab to trigger proxy authentication. Credentials entered in the browser’s authentication dialog are managed by the browser and are not copied into a MegaProxy profile.

When you run a connection check, the extension contacts example.com and public IP/country lookup services: ifconfig.me, api.ipify.org, icanhazip.com, ifconfig.co, ipapi.co and api.country.is. Some are fallback endpoints. They receive the IP address of the connection used for the check and ordinary HTTP request metadata. Results are displayed locally.

Automatic list features fetch catalog metadata and selected domain lists from GitHub (api.github.com and raw.githubusercontent.com, including itdoginfo/allow-domains). If selected lists exceed the rule limit, a public popularity ranking may be fetched from the wangmm001/tranco-top1m-cache GitHub mirror or tranco-list.eu to prioritize domains. These providers receive ordinary request metadata, including the source IP. The extension does not send your browsing history to rank domains. Updates can be sent through the active proxy. Unused lists are not downloaded in other routing modes; opening routing settings can refresh stale catalog metadata.

Importing a configuration from a URL contacts that user-provided address. That server receives normal request metadata. The imported configuration may contain proxy credentials; use a trusted source.

## Control and contact

You can disable synchronization, password synchronization and request monitoring in settings; clear diagnostic logs; remove profiles; and uninstall the extension to remove its local storage. Browser-synchronized copies are subject to the browser’s sync settings. Previously exported files must be deleted separately. Firefox private-window access allows the selected proxy settings to apply there too.

Questions and privacy issues: https://github.com/andre487/BrowserMegaProxy/issues. Avoid posting credentials or sensitive exported configurations in public issues.
