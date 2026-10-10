# Releasing MegaProxy

The process follows AndroidMegaProxy: manual version input → release PR →
required checks → merge → tag → build and GitHub Release → Chrome Web Store,
Firefox Add-ons and Opera Add-ons submission, all in one workflow run.

## One-time setup

1. Ensure `.github/workflows/prepare-release.yml` and `release.yml` are present
   on `main`. Run the release preparation workflow from that branch.
2. Create a fine-grained GitHub PAT for BrowserMegaProxy with
   **Contents: Read and write**, **Pull requests: Read and write**,
   **Actions: Read-only**, and **Checks: Read-only**. Its owner must be able to
   create branches/tags and merge PRs in this repository.
3. In **Settings → Secrets and variables → Actions → New repository secret**,
   save it as `RELEASE_BOT_TOKEN`, following AndroidMegaProxy.
   The normal `GITHUB_TOKEN` does not trigger CI for a PR it creates; [GitHub documents this limitation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
4. Keep all six checks required for `main`: `Linters`, `Unit tests`,
   `Chromium tests`, `Firefox tests`, `Firefox Android tests` and
   `Vivaldi Android tests`. These are already configured in the Protect Main ruleset.
5. Create a separate API key in [OpenAI Platform → API keys](https://platform.openai.com/api-keys):
   select a project, click **Create new secret key**, and save the issued key.
   For a restricted key, enable **Model capabilities → Request** and
   **Responses API → Write** (`POST /v1/responses`); other permissions can be None.
   The owner's project role must grant those permissions too.
   [OpenAI documents platform permissions](https://developers.openai.com/api/docs/guides/rbac).
   The project needs API billing and access to the selected model;
   a ChatGPT subscription does not cover API billing.
6. In **Settings → Secrets and variables → Actions → Secrets**, add the repository
   secret **OPENAI_API_KEY**. Never put the key in repository files.
7. Under **Variables**, add the repository variable **OPENAI_RELEASE_MODEL** with
   the value **gpt-6.1-sol**, following the other repositories. This is also the
   default when no variable exists. A secret with the same name is supported for
   compatibility. The workflow's **model** input overrides both the variable and secret.

The generator uses the [OpenAI Responses API](https://developers.openai.com/api/docs/quickstart)
and [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol).
It sends commit history and file-change statistics since the previous release
tag, or the complete history for the first release. File contents are not sent;
API response storage is disabled (`store: false`). The EN/RU changelog is saved in
`releases/vX.Y.Z.md`, included in the release PR, and published to GitHub Release
from the tagged commit. Republishing does not call OpenAI again.
API failures or invalid output stop preparation before committing and pushing.
Android signing and store credentials are not needed for GitHub releases.

## Each release

1. Merge the intended changes into `main`.
2. Open **Actions → Release MegaProxy → Run workflow**.
3. Select **main** and enter a new version without `v`, for example `0.1.1`.
   It must be at least the version in `package.json` and its release tag must not exist.
   The current version can be used for its first release; three components from 0–65535 are allowed,
   without leading zeros or `beta`/`rc` suffixes.
   Leave **model** empty to use `OPENAI_RELEASE_MODEL` / `gpt-6.1-sol`, or specify
   another model identifier available to your project.
4. Wait for completion. The workflow generates the EN/RU changelog, updates
   `package.json` and `package-lock.json`, creates `release/vX.Y.Z` and a PR,
   waits for all six checks, merges the PR, and tags the merge commit.
   It does not bypass checks with `--admin`.
5. The same run continues through **Verify CI, merge and tag** and **Publish release**.
   Publication checks out the exact tag and publishes archives with the committed EN/RU changelog.
   Required CI is verified on the release PR before merging; tag pushes do not start a second release run.
   Open the **Releases** page after the workflow completes.

If `main` changes during checks and the PR falls behind, use **Update branch**,
wait for CI, and merge the PR manually. The workflow verifies the original PR
commit and will not merge an updated branch automatically; tag the merge commit
using the recovery instructions below. If preparation fails after creating the PR,
inspect that PR rather than preparing the same version again over an existing branch.

## Release files

- `MegaProxy-chromium-vX.Y.Z.zip` — Chrome and Opera: unpacked developer installation
  or submission to the appropriate store.
- `MegaProxy-firefox-vX.Y.Z.zip` — unsigned Firefox package: temporary installation
  through `about:debugging` or submission to Mozilla for signing.
- `MegaProxy-source-vX.Y.Z.zip` — source from the tagged commit for review and rebuilding.
- `MegaProxy-store-materials-vX.Y.Z.zip` — fresh screenshots, icons, EN/RU listings
  and store submission documents.
- `SHA256SUMS` — SHA-256 checksums for all four archives.

Extension archives have `manifest.json` at their root. Store materials are
regenerated for each release. GitHub Release assets do not have the 14-day
retention limit used for PR artifacts. Republishing restores the description
from the tagged changelog, overwriting manual edits to that description.

## Firefox signing

Mozilla issues the signature; a developer's own certificate cannot replace it.
Use **listed** for the public store, or **unlisted** to distribute an XPI through
GitHub Release without an AMO listing.

Manual signing:

1. Sign in to [AMO Developer Hub](https://addons.mozilla.org/developers/) and accept
   the developer agreement.
2. Upload the Firefox ZIP and choose **On this site** for AMO or **On your own**
   for self-distribution.
3. If source is requested, attach the source ZIP. Build requirements: Node.js 22+,
   `npm ci && npm run build`; the Firefox package is in `dist/firefox`.
4. After review, download the signed `.xpi`. For self-distribution, attach it to
   GitHub Release through **Edit release → Attach files**.
   Do not repackage the signed XPI.

The [official web-ext CLI](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/#web-ext-sign)
also supports signing. Create [AMO API keys](https://addons.mozilla.org/developers/addon/api/key/)
and pass them through `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` environment
variables, never repository files. Example for self-distribution from a checkout of the tag:

```sh
npm ci
npm run build
npm run release:assets
# WEB_EXT_API_KEY and WEB_EXT_API_SECRET are already set in the environment.
npx --yes web-ext@10 sign \
  --channel unlisted \
  --source-dir dist/firefox \
  --upload-source-code dist/release/MegaProxy-source-vX.Y.Z.zip \
  --artifacts-dir dist/signed
```

Replace `X.Y.Z` with the tag version. `web-ext sign --channel unlisted` submits the
package to Mozilla and downloads the signed copy after approval. The `listed`
channel submits a public release; an initial listing also needs AMO metadata.
Review may require manual intervention and take longer than the CLI's wait period.
[Mozilla documents both distribution channels and signing](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/).
Automatic public AMO submission is described below. The unlisted signing command
above remains a separate manual option for self-distribution.

## Store publication

Chrome Web Store, Firefox Add-ons and Opera Add-ons submission can be automated as
described below. Use the listings, screenshots
and policy in [store/](store/README.md), and supply a public privacy-policy URL.
Before Opera publication, test the release in the target browser version.

### Chrome Web Store

[Install MegaProxy from the Chrome Web Store](https://chromewebstore.google.com/detail/megaproxy/kfilelfnldddoncicbampiojjjcpbigo).
The workflow targets this existing item (`kfilelfnldddoncicbampiojjjcpbigo`).
Chrome Web Store submission runs by default after a successful GitHub release.

Before the first submission, follow [Google's API setup guide](https://developer.chrome.com/docs/webstore/using-api)
to enable the Chrome Web Store API, configure OAuth consent and create an OAuth client.
Obtain a refresh token with scope `https://www.googleapis.com/auth/chromewebstore`
using that client's credentials and the Google account that owns the store item.

In **Settings → Secrets and variables → Actions**, configure:

- Repository variable `CWS_PUBLISHER_ID`: the publisher ID from the Chrome Web Store
  Developer Dashboard's **Publisher → Settings**.
- Repository secrets `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET` and `CWS_REFRESH_TOKEN`:
  the OAuth client credentials and refresh token.

The workflow supplies `CWS_EXTENSION_ID=kfilelfnldddoncicbampiojjjcpbigo` directly.
Local runs need all five `CWS_*` values above exported as environment variables
and the downloaded archive at `dist/release/MegaProxy-chromium-vX.Y.Z.zip`.
Keep credentials out of repository files.

After the GitHub Release succeeds, **Check or submit Chrome Web Store extension** downloads its
exact Chromium ZIP, checks archive integrity and manifest version, authenticates,
uploads through API v2, waits up to 150 seconds for processing, and submits with
`DEFAULT_PUBLISH`. Google reviews the update and publishes it after approval;
workflow success means submission was accepted, not that review has completed.
Store descriptions, screenshots, privacy fields and visibility stay managed in the
Web Store dashboard. Before submission, the job downloads the released materials
archive and compares its EN/RU summaries, detailed descriptions and ordered screenshots
with the public listing using HTTP, without a browser or dashboard session. Text
comparison ignores whitespace; images use approximate SSIM comparison, including
local regions. Differences produce warnings with a dashboard link, a job summary
and an artifact containing expected/current texts, images and highlighted differences.
Missing materials, network errors, changed page layout or invalid images also warn,
without preventing package submission or checks of other locales and screenshots.
The public page can still show the previous release during review. Dashboard drafts,
privacy fields, visibility and promotional tiles cannot be verified this way; inspect
them manually. Submissions are serialized across release tags.

For a dry run, open **Actions → Release extension artifacts → Run workflow** on
`main`, enter an existing GitHub release tag and enable **dry_run**. It downloads
the existing Chromium asset,
checks ZIP integrity and manifest version, obtains an access token and calls
`fetchStatus`. It does not rebuild, edit the GitHub release, upload or submit to
Google. It checks authentication and read access; only a real submission can
validate Google's package checks and publishing permissions.

To check locally with the same environment variables and downloaded archive:

```sh
CWS_DRY_RUN=true node scripts/chrome-web-store.mjs vX.Y.Z
```

If submission fails, fix the credentials or dashboard issue and **Re-run failed jobs**;
the successful GitHub Release job does not need to run again. A version already
pending review or published is skipped when reported by the API. Rejected or
cancelled submissions require attention in the dashboard. Publish code fixes as a
new version; recovery of an older version cannot downgrade the store item.

### Firefox Add-ons (AMO)

The **Submit to Firefox Add-ons** job submits the Firefox package to public AMO
using Mozilla's official `web-ext@10.7.0 sign --channel listed`. It downloads the
Firefox ZIP, source ZIP and store-materials ZIP from the same GitHub release, validates archive integrity,
versions and the manifest's `browser-mega-proxy@andre487` ID, then authenticates
with AMO's official JWT API. Store submissions are serialized across release tags.

The required repository secrets are `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`, obtained
from [AMO API credentials](https://addons.mozilla.org/developers/addon/api/key/).
The account must accept AMO's developer agreement and, if MegaProxy is already
listed, be an author of that listing. The manifest ID must match its AMO GUID; the store slug is not
used as the extension ID. Submission is enabled by default; set repository variable
`AMO_PUBLISH_ENABLED=false` to disable it. Configure the secrets before the next
release or disable submission until ready.

For a first submission, `web-ext` creates the listing using the tagged source
archive's reviewer notes and MIT license, with EN/RU listings from the released
store-materials archive and Other categories for desktop and Android. After
submission, the job updates the listing, privacy policy and icon, then uploads
the five English and five Russian Firefox screenshots with captions into AMO's
single shared gallery. AMO localizes captions, not the image gallery. Previous screenshots are removed
only after all replacements are accepted. Rerunning an already submitted version
still synchronizes materials without uploading the package again. Both first
submissions and updates include the source ZIP for reproducible review.

AMO reviewer notes are limited to 3,000 characters, including build instructions.
When the full store notes exceed that limit, the submission points reviewers to
`store/REVIEWER-NOTES.md` and `store/PERMISSIONS.md` in the attached source archive
and keeps the build instructions in the AMO field. Recovery uses the current
publishing script with the existing release archives, so this also handles older tags.

Run **Actions → Firefox Add-ons → Run workflow** with an existing release tag and
**dry_run** enabled (the default) to validate the archives, authenticate and check
ownership of an existing listing. A missing listing is reported as an initial
submission, without creating it. The common **Release extension artifacts** dry run
also checks Firefox unless `AMO_PUBLISH_ENABLED=false`. No upload, signing request,
listing edit or version submission occurs during dry runs. These checks cannot
confirm Mozilla's package validation or approval of a new listing.

Clear **dry_run** only to submit a real version. The job waits for upload/validation,
but not review approval (`--approval-timeout 0`); success means AMO accepted the
submission. AMO signs and publishes after approval. This integration does not
download a signed XPI or attach one to GitHub Release; public store installation
uses AMO, including on supported Firefox Android versions.

Unlike Opera's optional warning path, Firefox failures remain visible as failed
jobs while the existing GitHub release remains available. Fix credentials or
metadata in AMO, then rerun **Firefox Add-ons** for the same tag. Versions already
listed as public or awaiting review with attached source skip package submission
and still update store materials. Rejected,
disabled, unlisted or incomplete existing versions require dashboard attention;
the workflow does not silently replace or delete them.

See [Mozilla's signing command reference](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/#web-ext-sign)
and [JWT authentication documentation](https://mozilla.github.io/addons-server/topics/api/auth.html).

### Opera Add-ons

The optional **Submit to Opera Add-ons** job uses the existing Chromium ZIP from
GitHub Release. It calls the developer dashboard's undocumented HTTP API using
the session cookie in secret `OPERA_SESSION_ID` and the numeric package ID in
variable `OPERA_PACKAGE_ID`. The listing and its first version must already exist
in Opera's dashboard. Opera submission is enabled by default after normal releases;
set `OPERA_PUBLISH_ENABLED=false` to disable it explicitly.

The job uploads the ZIP in chunks and copies existing metadata and localized
summaries. It then independently updates EN/RU descriptions, support/source links,
privacy policy, icon, promotional image and the default English screenshot gallery
from the released store-materials ZIP before submitting for moderation. Each material
failure emits a warning and does not stop later materials or package submission.
Material attempts have separate deadlines; see `scripts/opera-addons.mjs`. Existing
screenshots are removed only after all replacements are accepted. It resumes a version already created in Opera after a failed attempt
and skips a version already submitted. A successful submission does not mean Opera
has approved or published it. Sessions can expire and dashboard API changes can
require updating the integration. No account password is stored by this workflow.

For a read-only check, run **Actions → Opera Add-ons → Run workflow**, select a
GitHub release tag and keep **dry_run** enabled (the default). It validates archive
integrity/version, reads the package and previous version metadata, and confirms
that the account can edit the listing. It does not upload, edit or submit a version.
Use this workflow independently to retry Opera without rebuilding GitHub assets or
triggering Chrome publication. Clearing **dry_run** submits the selected release.
The **Release extension artifacts** workflow with **dry_run** enabled also checks
Opera unless `OPERA_PUBLISH_ENABLED=false`, alongside its Chrome access check.

Opera API requests retry HTTP 5xx with exponential backoff; see
[HTTP failure diagnostics](#http-failure-diagnostics) for the retry policy.

Failures in normal Opera submission are non-blocking: the workflow emits a warning
and a job summary with manual upload and credential renewal instructions. GitHub
Release and Chrome publication continue independently. A green workflow does not
confirm Opera submission: check the integration step's log for confirmation and
the summary for recovery warnings. Dry-run failures remain
blocking so invalid credentials are reported clearly.

If creating a version returns HTTP 500 after upload, the dry run does not exercise
that failing request. Check the endpoint and response excerpt before changing
credentials; a server error alone does not mean the session expired. Try the same
ZIP through the dashboard and inspect its response to distinguish an integration
request problem from a failure in Opera's package processing.

Manual recovery: download the Chromium ZIP from the GitHub release, open
[Opera Developer Dashboard](https://addons.opera.com/developer/), select the extension's
**Versions** tab, upload the ZIP, verify metadata and submit for moderation. To
renew access, sign in to that dashboard, copy its `sessionid` cookie from browser
DevTools → Application → Cookies and replace GitHub secret `OPERA_SESSION_ID`.
Check `OPERA_PACKAGE_ID` against the numeric ID in the dashboard URL, then run a
dry run before retrying. Never share or commit the cookie value.

API behavior is based on the [publish-browser-extension implementation](https://github.com/aklinker1/publish-browser-extension/blob/main/src/stores/opera-addons-store.ts);
Opera's supported manual process is described in its [publishing guidelines](https://help.opera.com/en/extensions/publishing-guidelines/).

All store integration scripts print developer-dashboard links in logs and job summaries.

## HTTP failure diagnostics

Release API calls (Chrome, Firefox, Opera and release-note generation), schema/catalog
renewal and extension downloads include response excerpts for HTTP 500–599 errors.
The shared handler reads at most 16 KiB and outputs at most 4,096 characters, with
known credentials, authorization fields, URLs and control characters redacted.
Errors identify the method and endpoint in release logs. By default, release and maintenance
API calls and extension configuration downloads retry HTTP 5xx up to three total
attempts with 1 and 2 second delays. Opera uses a longer exponential retry policy,
configured in `scripts/opera-addons.mjs`; its request timeout starts afresh for each
attempt. The Opera job time limit is configured in `.github/workflows/opera-addons.yml`.
Each retry logs its response excerpt. Connection checks do not retry requests.
HTTP 4xx and transport failures are not retried by this handler. Opera separately
retries HTTP 400/404 during version creation while uploaded chunks become available.
Empty or unreadable bodies
are marked explicitly; HTTP 4xx response bodies are not logged.

Extension 5xx diagnostics are also retained across error wrapping and displayed in
the UI and local diagnostic log. Connection checks read the error page's visible
text when accessible. The network monitor uses browser webRequest events, which
provide status codes rather than arbitrary response bodies; it does not replay
requests to collect bodies.

## Recovery after failure

If the release workflow fails after a tag appears, resolve the external cause and
select **Re-run failed jobs**. Existing assets for that tag are replaced; no duplicate
release is created. Code changes require a new version.

If preparation fails after merging the PR but before tagging, manually tag that
PR's merge commit (replace the placeholders):

```sh
git fetch origin main
git tag vX.Y.Z MERGE_COMMIT_SHA
git push origin refs/tags/vX.Y.Z
```

The tag version must match `package.json` on that commit, which must also contain
a nonempty EN/RU changelog at `releases/vX.Y.Z.md`. For a manual release, write it
yourself or generate it with `node scripts/release.mjs notes X.Y.Z`, with
`OPENAI_API_KEY` in the environment, and commit it before creating the tag.
After manually creating a recovery tag, run **Release extension artifacts** with that
existing tag to publish it. This recovery workflow builds the tagged commit without
creating a PR or rerunning the already verified release PR checks. A tag push alone
does not publish a release.
