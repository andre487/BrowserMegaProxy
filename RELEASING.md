# Releasing MegaProxy

The process follows AndroidMegaProxy: manual version input → release PR →
required checks → merge → tag → build and GitHub Release, all in one workflow run.

## One-time setup

1. Merge the PR containing `.github/workflows/prepare-release.yml` and `release.yml`
   into `main`. The manual workflow appears in Actions after that merge.
2. Create a fine-grained GitHub PAT for BrowserMegaProxy with
   **Contents: Read and write**, **Pull requests: Read and write**,
   **Actions: Read-only**, and **Checks: Read-only**. Its owner must be able to
   create branches/tags and merge PRs in this repository.
3. In **Settings → Secrets and variables → Actions → New repository secret**,
   save it as `RELEASE_BOT_TOKEN`, following AndroidMegaProxy.
   The normal `GITHUB_TOKEN` does not trigger CI for a PR it creates; [GitHub documents this limitation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
4. Keep `Linters`, `Unit tests`, `Chromium tests`, and `Firefox tests` required for
   `main`. These are already configured in the Protect Main ruleset.
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
   the value **gpt-6-luna**, following the other repositories. This is also the
   default when no variable exists. A secret with the same name is supported for
   compatibility. The workflow's **model** input overrides both the variable and secret.

The generator uses the [OpenAI Responses API](https://developers.openai.com/api/docs/quickstart)
and [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna).
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
   Leave **model** empty to use `OPENAI_RELEASE_MODEL` / `gpt-6-luna`, or specify
   another model identifier available to your project.
4. Wait for completion. The workflow generates the EN/RU changelog, updates
   `package.json` and `package-lock.json`, creates `release/vX.Y.Z` and a PR,
   waits for all four checks, merges the PR, and tags the merge commit.
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
- `MegaProxy-source-vX.Y.Z.zip` — source from the tagged commit for review and reproducible builds.
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
These workflows do not enable automatic signing or automatic store publication.

## Store publication

Upload the Chromium ZIP to Chrome Web Store and Opera Add-ons. Upload the Firefox
ZIP to Firefox Add-ons through your Mozilla account. Use the listings, screenshots
and policy in [store/](store/README.md), and supply a public privacy-policy URL.
Before Opera publication, test the release in the target browser version.

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
