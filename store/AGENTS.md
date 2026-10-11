# Store material synchronization: agent runbook

Read this before auditing or changing store listings. Scope: store metadata and
images, not a new extension release. Use existing helpers; do not build another
uploader for a one-off dashboard recovery.

## Fast path

1. Identify the target release and read store job summaries/warnings first.
   Package publication and material synchronization are separate outcomes;
   a green release or an accepted package does not prove that images were updated.
2. For an existing release, use its `MegaProxy-store-materials-vX.Y.Z.zip` as
   the reference. Download once and extract into a temporary directory. Do not
   regenerate screenshots or compare against a newer working tree. For unreleased
   source edits, use `store/listings/` and `store/assets/` instead.
3. Run `npm run store:check:chrome -- vX.Y.Z` when the archive is available at
   `dist/release/MegaProxy-store-materials-vX.Y.Z.zip`. Read the compact report,
   then inspect only differences. This checks the public Chrome listing, not
   drafts, privacy fields, icons or promotional tiles.
4. Read [README.md](README.md) for the asset/locale mapping and the relevant
   section of [RELEASING.md](../RELEASING.md#store-publication) for automation.
   The Firefox job already synchronizes supported materials; Chrome and Opera
   require separate dashboard edits. The Opera job only uploads/submits the package. Do not rerun a whole publication workflow merely
   to repair images: it may upload or submit the package again.
5. In the dashboard, collect one compact baseline: version/status, localized
   text, image URLs/order/count, support/homepage and privacy fields. Compare
   before editing. Change only differences, save, reload and verify persistence.
6. Report each store separately: materials saved, publicly visible, submitted
   for review, or blocked. Never describe a draft as published.

## Browser access and token budget

- Prefer available Playwright tools connected to the user's authorized browser.
  If an extension connection rejects a store page with `Not allowed`, use
  native CDP when available. Ask the user to enable **Allow remote debugging for
  this browser instance** at `chrome://inspect/#remote-debugging` if necessary.
  Do not copy their profile or extract session credentials as a workaround.
- If only CLI access is available, attach to that Chrome instance:
  `npx --yes @playwright/cli -s=store-sync attach --cdp=chrome`.
  This is an operational fallback, not a project dependency. Detach afterward;
  do not close the user's browser.
- List tabs once and retain their mapping. Select the correct tab explicitly.
  Await each browser command to completion, including a yielded process, before
  another command changes tabs or navigates. Browser mutations are sequential.
- Use one targeted snapshot to locate an unfamiliar control. Afterward use
  observed role/label or scoped selectors. Return small JSON summaries, counts,
  comparisons and statuses instead of full DOM, screenshots or descriptions.
  Store detailed evidence temporarily and read only the relevant excerpt.
- Batch independent local reads and image comparisons. Keep edits, confirmation
  dialogs, uploads and verification sequential. Check upload completion by state
  or count, not fixed sleeps. Selecting a file is not proof of uploading it.
- Scope file inputs/buttons to their visible section. Respect deletion dialogs.
  Do not force clicks through overlays. After reload, wait for dashboard controls;
  Opera may reset to General instead of retaining the requested tab.
- Use `setInputFiles(path)` with native CDP. If extension-based file transfer fails,
  a Playwright file payload `{name, mimeType, buffer}` is a fallback; keep base64 in
  a temporary script and never print it. Do not retry a timed-out transfer blindly.

## Chrome Web Store

- Package name/short summary come from the uploaded extension. Edit long
  descriptions in both EN and RU and verify them against release sources.
- Check three screenshot groups: EN localized (5), RU localized (5), and the
  global fallback (5 EN). Also check the 128px icon, small promo and marquee.
  Identify groups from labels/DOM; numeric file-input indices are not a contract.
- A pending review can lock editing. Within authorized synchronization, explain
  that cancelling review returns the same submission to a draft, make the edits,
  save and resubmit it. Avoid uploading/rebuilding the package unnecessarily.
  Preserve the existing automatic-publication preference unless instructed otherwise.
- Delete images with the dashboard confirmation and wait for the count to change.
  Upload replacements one at a time. Save the draft and reload; verify both locales
  before submitting. Confirm the resulting review status.
- While review is pending, the public freshness checker may still see old images.
  Verify the saved dashboard draft directly rather than repeatedly polling public data.

## Firefox Add-ons (AMO)

- One shared gallery: 5 EN images followed by 5 RU images; not separate galleries.
  Captions are localizable (`en-US`, `ru`). Preserve applicable captions for every
  image, and verify each language explicitly rather than assuming locale switching saved it.
- If the authenticated API is rate limited for hours, stop retrying in the foreground.
  The authorized dashboard session is a separate recovery path. Do not extract JWTs
  or cookies. The public `/api/v5/addons/addon/<public-addon-id>/` response can verify
  version, descriptions, previews/order, captions and icon without authentication.
- Edit the media form, upload all replacements and confirm completed uploads before
  marking old images for removal. Set gallery positions and captions, then save.
  Locale-change/unsaved-change dialogs can block submission: resolve them explicitly.
  Select the locale choice, not its adjacent locale-removal control.
- Listing edits can become public on save without a separate version review.
  Verify through the public listing/API; do not resubmit an already published
  package just to obtain a review status for metadata.

## Opera Add-ons

- Version Media: 3 EN screenshots and 64px icon. Version Translations: EN/RU
  summaries/descriptions. Package Promotional Image: 300×188 promo, a separate section.
  The dashboard asks for Opera captures; current generated assets reuse Chromium UI.
  Do not claim they were captured in Opera; follow moderator requirements if requested.
- Flow uploader requires selecting files **and** clicking its section's upload
  control (`$flow.upload()` in the observed UI). Another hidden uploader may exist
  on the same page. Scope to the appropriate panel; wait for the attached image.
- A failed PATCH/HTTP 500 may have changed server state. Reload/read back before
  repeating an attachment or deletion; blind retries can duplicate screenshots.
  GET chunk-probe HTTP 405 alone is not upload failure: check the final attachment.
- `Icon with this size already exists` and `Promotional Image already exists`
  are known replacement failures. Do not delete a valid promo as an experiment:
  deletion can persist while both new upload and restoration still fail with
  `already exists`. Preserve it and report the blocker. If already removed, try
  restoring the saved original once and report its actual resulting state.
- Material changes can leave the version with unsubmitted edits. Use General →
  Submit changes after verifying saved materials; confirm the dashboard's submission
  message/status. Do not send moderator messages without explicit authorization.

## Verification and privacy

- Compare text after trimming/normalizing whitespace. Compare images by content,
  not filenames, CDN hashes or byte equality. Reuse exported `compareScreenshots`
  from `scripts/chrome-store-materials.mjs`; summarize `similar`, `mean`, `region`.
  Review flagged differences: store resizing/JPEG compression is expected.
  For AMO's resized icon compare against `icon-128.png`, not Opera's `icon-64.png`.
- Download only observed public image URLs for unauthenticated comparisons.
  Check image order/count, all intended locales, captions and moderation state
  after saving/reloading. Keep baseline images until replacement is verified.
- Never commit account/publisher IDs, personal paths, emails, session data, cookies,
  tokens, browser storage, authenticated network dumps or user configuration.
  Derive identifiers from the current authorized dashboard; use placeholders in
  reusable instructions. Do not print hidden inputs or full network headers.
- Keep diagnostic artifacts outside the repository or in ignored test output.
  Detach browser automation and leave the worktree free of generated CLI artifacts.
  Final report: what changed per store, evidence of persistence/publication and
  exact remaining blockers. Do not wait indefinitely for external moderation.
