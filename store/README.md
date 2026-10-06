# MegaProxy store materials

Prepared for Chrome Web Store, Firefox Add-ons (AMO) and Opera Add-ons. English and Russian copy is in `listings/{chrome,firefox,opera}/{en,ru}.json`: paste the name, summary and description into the corresponding store fields. Each summary is at most 132 characters. Screenshot captions are supplied for accessibility fields where available. Release store-materials archives include readable Markdown copies beside the JSON listings.

Run `npm run store:materials` to copy the current assets and generate all six Markdown listings in `dist/store-materials/store/`. JSON files remain the source of truth; release packaging runs this generation automatically.

| Store            | Screenshots                                       | Icon                                                     | Promotion                                       |
| ---------------- | ------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------- |
| Chrome Web Store | `assets/chromium/{en,ru}/01.png` … `05.png`       | `assets/shared/icon-128.png`                             | `promo-small.png`; optional `promo-marquee.png` |
| Firefox Add-ons  | `assets/firefox/{en,ru}/01.png` … `05.png`        | `assets/shared/icon-128.png`                             | Not needed                                      |
| Opera Add-ons    | Reuse `assets/chromium/{en,ru}/01.png` … `05.png` | `assets/shared/icon-128.png`; `icon-64.png` if requested | Not required by this kit                        |

Screenshots are 1280×800 opaque PNGs. They show actual packaged UI rendered in Chromium or Firefox with isolated fictional profiles, counters and connection results. The screenshots are composed with captions; no credentials, user profiles or real endpoint information are used. Opera reuses the Chromium UI materials, rather than claiming screenshots from an Opera session. The Firefox routing screenshot shows its exclusive By tabs mode.

The shared 128×128 icon has 96×96 artwork and 16 px transparent margins. Promotion images are 440×280 and 1400×560 opaque PNGs, without locale-specific text. They reuse the AndroidMegaProxy logo under the license in `assets/shared/LICENSE`.

## Regenerate

```sh
npm ci
npx playwright install chromium firefox
npm run store:assets
```

The command builds the extension and regenerates all PNGs with the installed Playwright browsers. It does not need a proxy, a browser profile or external HTTP requests. It checks image dimensions and UI errors while generating. Font rendering can differ by operating system.

## Submission documents

- [Privacy policy](PRIVACY.md): publish at a public URL and provide it to the stores.
- [Reviewer notes](REVIEWER-NOTES.md): permission explanations, review steps and package selection.

These materials do not publish the extension. The store dashboard’s current fields, release package and target-browser behavior still need to be checked at submission time. Prepared on 6 October 2026 using the official guidance:

- [Chrome image requirements](https://developer.chrome.com/docs/webstore/images) and [listing fields](https://developer.chrome.com/docs/webstore/cws-dashboard-listing).
- [Mozilla listing guidance](https://extensionworkshop.com/documentation/develop/create-an-appealing-listing/).
- [Opera publishing guidelines](https://help.opera.com/en/extensions/publishing-guidelines/) and [acceptance criteria](https://help.opera.com/en/extensions/acceptance-criteria/). Opera’s public guidance does not specify an exact screenshot size; 1280×800 is supplied for reuse, not presented as an Opera requirement.
