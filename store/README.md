# MegaProxy store materials

[Install MegaProxy from the Chrome Web Store](https://chromewebstore.google.com/detail/megaproxy/kfilelfnldddoncicbampiojjjcpbigo).
Automatic Chrome release submission and dry runs are described in [RELEASING.md](../RELEASING.md#chrome-web-store).
Optional Opera submission, dry runs and manual recovery are described in [RELEASING.md](../RELEASING.md#opera-add-ons).
Firefox Add-ons submission and dry runs are described in [RELEASING.md](../RELEASING.md#firefox-add-ons-amo).

Prepared for Chrome Web Store, Firefox Add-ons (AMO) and Opera Add-ons. English and Russian copy is in `listings/{chrome,firefox,opera}/{en,ru}/`: Firefox and Opera release jobs synchronize supported fields from the released materials archive; Chrome checks the published listing and warns about differences requiring manual synchronization in its dashboard. Each summary is at most 132 characters. Screenshot captions are supplied for accessibility fields where available.

Run `npm run store:check:chrome` to compare the public Chrome listing with the repository without a browser or store credentials. The report and comparison images are saved under `test-results/chrome-store-materials/`; use `npm run store:check:chrome -- --help` for release-archive checks. Text comparison ignores whitespace differences. Image comparison normalizes resolution and color space, lightly smooths compression noise, then uses SSIM across RGB channels for both the whole image and local regions, so compression and resizing can match while a small UI change can still trigger a warning. The comparison is approximate; review differences before replacing materials. Fetch, parsing, image decoding and report errors warn instead of stopping publication.

Edit `name.txt`, `summary.txt`, `description.txt`, `homepage.txt` and `support.txt` directly.
Descriptions use plain text with `•` bullet markers, not Markdown. Put one screenshot
caption per line in `screenshot-captions.txt`, in gallery order.

Run `npm run store:materials` to copy these sources and current assets to
`dist/store-materials/store/`. Packaging derives the six JSON listings used by the
existing release integrations and combined Markdown copies for convenience; those
generated files are not sources to edit or commit. Existing release archives remain
compatible with the uploaders. Release packaging runs this generation automatically.

| Store            | Screenshots                                           | Icon                         | Promotion                                       |
| ---------------- | ----------------------------------------------------- | ---------------------------- | ----------------------------------------------- |
| Chrome Web Store | `assets/chromium/{en,ru}/01.png` … `05.png`           | `assets/shared/icon-128.png` | `promo-small.png`; optional `promo-marquee.png` |
| Firefox Add-ons  | `assets/firefox/{en,ru}/01.png` … `05.png`            | `assets/shared/icon-128.png` | Not needed                                      |
| Opera Add-ons    | `assets/opera/en/01.png` … `03.png` (default gallery) | `assets/shared/icon-64.png`  | `promo-opera.png` (300×188)                     |

Chrome and Firefox screenshots are 1280×800 opaque PNGs; Opera copies are resized to 612×408 with opaque margins. They show actual packaged UI rendered in Chromium or Firefox with isolated fictional profiles, counters and connection results. The screenshots are composed with captions; no credentials, user profiles or real endpoint information are used. Opera reuses the Chromium UI materials, rather than claiming screenshots from an Opera session. The Firefox routing screenshot shows its exclusive By tabs mode.

Chrome supports localized screenshot sets. AMO has one shared screenshot gallery
with localizable captions; the current integration uploads the five English and
five Russian Firefox images into that shared gallery, not separate locale galleries.
Opera uses the first three English captures. The five-caption JSON arrays are shared
listing source data; only the screenshots supported by each integration are uploaded.

The shared 128×128 icon has 96×96 artwork and 16 px transparent margins. Promotion images are 300×188 (Opera), 440×280 and 1400×560 opaque PNGs, without locale-specific text. They reuse the AndroidMegaProxy logo under the license in `assets/shared/LICENSE`.

## Regenerate

```sh
npm ci
npx playwright install chromium firefox
npm run store:assets
```

The command builds the extension and regenerates all PNGs with the installed Playwright browsers. It does not need a proxy, a browser profile or external HTTP requests. It checks image dimensions and UI errors while generating. Font rendering can differ by operating system.

## Submission documents

- [Privacy policy](PRIVACY.md): publish at a public URL and provide it to the stores.
- [Permission justifications](PERMISSIONS.md): English text for each requested permission and host access.
- [Reviewer notes](REVIEWER-NOTES.md): review steps and package selection.

Release integrations use the generated store-materials archive; see [RELEASING.md](../RELEASING.md) for automatic updates, warning handling and manual Chrome synchronization. The generator also prepares three Opera-sized screenshots per locale from the Chromium UI gallery. Opera uploads the English gallery because its dashboard has no localized screenshot field. Its dashboard asks for captures made in Opera, so reviewers may require native Opera replacements. Check the target-browser behavior and remaining dashboard requirements at submission time.

- [Chrome image requirements](https://developer.chrome.com/docs/webstore/images) and [listing fields](https://developer.chrome.com/docs/webstore/cws-dashboard-listing).
- [Mozilla listing guidance](https://extensionworkshop.com/documentation/develop/create-an-appealing-listing/).
- [Opera publishing guidelines](https://help.opera.com/en/extensions/publishing-guidelines/) and [acceptance criteria](https://help.opera.com/en/extensions/acceptance-criteria/).
