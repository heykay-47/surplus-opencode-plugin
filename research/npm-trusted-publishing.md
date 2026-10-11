# npm trusted publishing (OIDC) for `opencode-surplus`

Research for issue #4. Researched 2026-10-11. Nothing was published, retagged, or reconfigured.

**Short answer:** Yes. Trusted publishing works from a private GitHub repository. It does not need an npm token, and it is not subject to the 2FA rule that caused the E403. Provenance is the one feature lost: npm does not generate it for private repositories and rejects it if you request it. For prerelease tags, CI must pass `--tag beta`, or rely on `publishConfig.tag`, which this package already sets. The registry reportedly does not let you delete `latest`. While only betas exist, the realistic choice is to keep `latest` on the newest beta and correct the README.

Labels used below: **Fact** means the claim is stated in the cited source. **Inference** is my conclusion from facts. **Unknown** means it is unverified.

## Repository state observed today

- **Fact:** npm reports dist-tags `{ latest: '0.3.0-beta.1', beta: '0.3.0-beta.1' }` and the versions `0.0.0-stage` (2026-10-07T07:25:02Z) and `0.3.0-beta.1` (2026-10-07T07:26:18Z). Neither version has provenance attestations (`dist.attestations` is absent). Source: `npm view opencode-surplus` and `https://registry.npmjs.org/opencode-surplus`.
- **Fact:** `0.0.0-stage` has the description "Temporary package placeholder for staged publishing". The npm docs say staging a package that does not yet exist creates a public placeholder version `0.0.0-stage` [S5].
- **Fact (discrepancy with the brief):** On 2026-10-11, `gh api repos/heykay-47/surplus-opencode-plugin` returns `"private": false, "visibility": "public"`, and the repo page returns HTTP 200 without authentication. The brief describes the repo as private. Everything below covers both cases, because provenance is the main difference.
- **Fact:** `package.json` has `publishConfig: { access: "public", tag: "beta" }` and `repository.url: https://github.com/heykay-47/surplus-opencode-plugin`. `scripts/check-package.mjs` asserts `publishConfig.tag === "beta"`.
- **Fact:** README line 27 says "Beta releases use the `beta` distribution tag, not `latest`." That does not match the registry state above.

## (a) Private repositories and provenance

- **Fact:** GitHub's 2025-07-31 GA announcement says trusted publishing is available for "All npm private and public packages, both scoped and unscoped". It also says "provenance remains unavailable when publishing from private source repositories" [S2].
- **Fact:** The trusted publishing docs, last edited 2026-10-06, say automatic provenance requires all of: trusted publishing, a public repository, and a public package. They also say "Provenance generation is not supported for private repositories, even when publishing public packages" [S1].
- **Fact:** The docs limit trusted publishing to GitHub-hosted runners; self-hosted runners are not supported [S1].
- **Fact:** GitHub stopped supporting provenance from private source repositories on 2023-07-25. If a linked repository is later made private, npmjs.com shows an error on the package's provenance information [S8].
- **Fact (CLI source):** npm turns on provenance automatically only when the GitHub OIDC claim `repository_visibility === 'public'` and the package is public. Otherwise it publishes without provenance [S10, local npm 12.2.0 `lib/utils/oidc.js`]. GitHub's OIDC token includes `repository_visibility` (`public`, `private`, or `internal`) and can be issued to private repositories [S11].
- **Fact (community report, not official docs):** Forcing provenance (`--provenance`, `publishConfig.provenance: true`, or `NPM_CONFIG_PROVENANCE=true`) from a private repo fails with `E422 ... Unsupported GitHub Actions source repository visibility: "private"`. Wrapper tools can mask this as E404 or ENEEDAUTH [S13].
- **Inference:** While the repo is private, publish without any provenance setting. If the repo stays public (as it is today), the first CI publish will carry provenance automatically. If the repo is made private afterwards, those published attestations will show errors on npmjs.com [S8].

## (b) 2FA and the E403

- **Fact:** "All packages now require two-factor authentication (2FA) or a granular access tokens with bypass 2FA enabled for creating and publishing packages." For CI, npm recommends trusted publishing instead [S3]. This matches the earlier E403.
- **Fact:** The npm stage docs list "Trust token (OIDC)" as "Can publish (if allowed)", with no 2FA prompt. Session tokens and granular access tokens without bypass get a 2FA prompt instead [S6].
- **Fact:** The package-level setting "Require two-factor authentication and disallow tokens" blocks traditional tokens only: "Your trusted publishers will continue to work normally, as they use OIDC tokens." npm recommends turning it on once trusted publishing works [S1].
- **Fact:** Trusted publisher configurations created after 2026-09-03 allow only `npm stage publish` by default. Direct `npm publish` must be enabled explicitly. Staged packages go live only after a maintainer approves them with 2FA [S1][S5].
- **Inference:** An OIDC publish from an authorized workflow avoids the E403 caused by the 2FA requirement. You choose between two models:
  - Enable "npm publish" on the trusted publisher, so CI publishes directly.
  - Keep the stage-only default, so CI runs `npm stage publish` and a human approves each release with 2FA, which keeps proof of presence.
- **Unknown:** E403 can have other causes, such as the wrong account or package ownership. Only a real CI run confirms the fix.

## (c) Prerelease dist-tags from CI

- **Fact:** npm 11.0.0 (2024-12-16) made publishing a prerelease without an explicit tag an error: "You must specify a tag using --tag when publishing a prerelease version." This came from npm/cli PR #7910 [S9].
- **Fact:** Commit `7f72944` (2025-01-17) made `publishConfig.tag` count as an explicit tag, so the guard does not fire when `publishConfig.tag` is set. The check `isDefaultTag = config.isDefault('tag') && !manifest.publishConfig?.tag` is present in v11.1.0 and in npm 12.2.0 [S10][S12].
- **Fact:** A command-line `--tag` overrides the matching `publishConfig` key [S10].
- **Fact:** libnpmpublish sends exactly one dist-tag with the version: `--tag`, otherwise `publishConfig.tag`, otherwise `latest` [S10].
- **Fact:** The "previously published version is higher" guard ignores prerelease and deprecated versions, so it does not affect betas [S10].
- **Fact (maintainer comment, npm/cli#8490, 2025-08-07):** The first publish of a package with any tag also receives `latest`. Later publishes with a non-`latest` tag leave `latest` where it was [S7].
- **Inference:** For this package, a bare `npm publish` publishes to `beta` because of `publishConfig.tag`, and the guard passes. Passing `--tag beta` in CI is still worth doing, because it makes the intent visible. Each new beta moves `beta` but leaves `latest` on `0.3.0-beta.1` unless CI moves it as well (see (d)).

## (d) Can `latest` be removed?

- **Fact:** npm's docs give `latest` special meaning: it is the tag that `npm install <pkg>` resolves. "Other than `latest`, no tag has any special significance to npm itself." The docs do not say that `latest` can never be removed [S4].
- **Fact:** The CLI does not stop you from running `npm dist-tag rm <pkg> latest` (no client-side check in `lib/commands/dist-tag.js`) [S10].
- **Fact (user report):** The registry answered `400 Bad Request` when a user tried to remove `latest`. The reporter concluded "it must be required so that `npm install package@latest` always works". The issue was closed without an official statement [S7].
- **Fact:** npm 12.2.0 (2026-09-30) and npm 11.21.0 (2026-09-30) support `npm dist-tag` with OIDC. It only works if the trusted publisher has "Allow npm dist-tag" turned on, which is off by default and separate from publish rights [S1][S9]. `npm trust` in 12.2.0 has no flag for this, so it must be turned on in the website settings (local `npm help trust`).
- **Fact:** Unpublish policy: after 72 hours, a version can be unpublished only if nothing depends on it, it had fewer than 300 downloads last week, and it has one maintainer. A version number can never be reused. Deprecation is the recommended alternative [S14][S15].
- **Not tested:** Deleting or moving `latest`. The brief does not allow it.

Options while `0.3.0-beta.1` is the only real version (all inferences):

1. **Recommended:** Accept that `latest` exists and fix the README. In the publish workflow, after `npm publish --tag beta`, run `npm dist-tag add opencode-surplus@$VERSION latest` through OIDC (requires npm ≥ 12.2.0 and "Allow npm dist-tag"). Otherwise `npm install opencode-surplus` keeps installing the oldest beta. Stop moving `latest` once a stable version exists.
2. Leave `latest` on `0.3.0-beta.1` and only change the README wording. This is simpler, but `latest` falls further behind with every beta.
3. Point `latest` at `0.0.0-stage`. Not recommended: a bare install would then fetch the placeholder.
4. Delete `latest`. Probably refused by the registry (400 report), and not documented as supported.
5. Separately, optional: deprecate `0.0.0-stage`, or unpublish it if it meets the policy criteria, so the placeholder disappears from installs and listings. This does not affect `latest`.

## (e) Minimal setup

On npmjs.com, under package settings → Trusted publishing, add a GitHub Actions publisher [S1]:

- User `heykay-47`, repository `surplus-opencode-plugin`, workflow filename `publish.yml` (filename only, `.yml` included, case-sensitive). Environment is optional; if you set one, it must match the job's `environment:`.
- Allowed actions: tick **npm publish** for direct CI publishing, or keep the stage-only default and approve with 2FA. Tick **npm dist-tag** only if CI should move `latest` (option 1).
- Timing: a new configuration must complete its first successful publish within 2 days. That publish binds it to the repository's immutable identity; an unused configuration expires and must be recreated [S1].
- After the first CI publish succeeds, set Publishing access to "Require two-factor authentication and disallow tokens", and revoke any bypass-2FA token [S1][S3].
- Also: npm does not validate the configuration when you save it [S1]. `repository.url` must match the GitHub repo [S1]. Up to 10 publishers can be configured per package. Existing connections can't be edited; delete and re-create them [S1].

The workflow, as a sketch based on [S1][S10][S11] (not committed):

```yaml
# .github/workflows/publish.yml
name: Publish
on:
  push:
    tags: ['v*']
permissions:
  contents: read
jobs:
  publish:
    runs-on: ubuntu-latest            # GitHub-hosted runner required
    permissions:
      contents: read
      id-token: write                 # needed for the OIDC token exchange
    steps:
      - uses: actions/checkout@v4
        with: { persist-credentials: false }
      - uses: actions/setup-node@v4
        with:
          node-version: 24            # npm docs: Node >= 22.14.0
          # no cache: npm docs say "never use caching in release builds"
      - run: npm ci
      - run: npm run typecheck && npm test
      - run: test "v$(node -p 'require("./package.json").version')" = "$GITHUB_REF_NAME"
      - run: npm run check:package
      - run: npm install -g npm@^12.2.0   # >= 11.5.1 for OIDC publish; >= 12.2.0 for OIDC dist-tag
      - run: npm publish --tag beta       # or: npm stage publish --tag beta
      # option (d)1, only with "Allow npm dist-tag":
      # - run: npm dist-tag add "opencode-surplus@${GITHUB_REF_NAME#v}" latest
```

Notes on the workflow:

- Requirements: npm CLI ≥ 11.5.1, Node ≥ 22.14.0, and `id-token: write` [S1].
  - **Inference:** The existing CI uses Node 22. I have not confirmed which npm version is bundled with the runner's Node, so the workflow upgrades npm explicitly.
  - **Unknown:** npm 12 requires Node `^22.22.2 || ^24.15.0 || >=26` [S12]. It also blocks dependency install scripts by default [S9]. That is why the upgrade comes after `npm ci`.
- Provenance: do not add `--provenance` or `publishConfig.provenance` while the repo is private (see (a)).
- `prepack` runs during `npm publish`, so the uploaded tarball is rebuilt from the checkout in the same job [S10].
- `workflow_dispatch`/`workflow_call`: validation uses the calling workflow's filename, and both workflows need `id-token: write` [S1].
- `setup-node` `registry-url`: npm's own example sets it [S1]. One community report says the placeholder `NODE_AUTH_TOKEN` it writes can mask OIDC [S13]. This package has no private dependencies, so leaving it out is the lower-risk choice (inference).
- Environments: on GitHub Free, Pro, and Team, required reviewers only work in public repos. Deployment branch and tag restrictions in private repos need Pro or Team [S16].
  - **Unknown:** the account's GitHub plan.
  - **Inference:** If the repo is private on Free, the stage-only publisher with 2FA approval is the practical human gate.

## Unknowns

- Whether the registry always refuses to delete `latest`. The only evidence is one user report [S7]. The official docs neither confirm nor deny it.
- How `latest` came to point at `0.3.0-beta.1`. The package was published with `--tag beta`. Possibly the registry auto-assigns `latest` to the first publish [S7], or it happened through the staged-placeholder flow. The audit trail was not available.
- Whether `0.0.0-stage` meets the unpublish criteria (download count, dependents).
- Whether registry matching of `repository.url` accepts the current URL form (`https://…`, normalized to `git+https://….git` on the registry). Several community threads mention exact matching [S1][S13]. Most likely fine, but only a real publish confirms it.
- The repository's intended final visibility, given the API reports `public` today.
- The npm version bundled with the runner's Node 24 image.

## Sources

- [S1] npm Docs, "Trusted publishing for npm packages", https://docs.npmjs.com/trusted-publishers (last edited 2026-10-06; fetched 2026-10-11).
- [S2] GitHub Changelog, "npm trusted publishing with OIDC is generally available", 2025-07-31, https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/
- [S3] npm Docs, "Requiring 2FA for package publishing and settings modification", https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification (last edited 2026-08-03).
- [S4] npm Docs, `npm dist-tag` (v12), https://docs.npmjs.com/cli/v12/commands/npm-dist-tag ; "Adding dist-tags to packages", https://docs.npmjs.com/adding-dist-tags-to-packages
- [S5] npm Docs, "Staged publishing for npm packages", https://docs.npmjs.com/staged-publishing/
- [S6] npm Docs, `npm stage` (v12), https://docs.npmjs.com/cli/v12/commands/npm-stage/
- [S7] npm/cli#8490, "npmjs doesn't allow removing 'latest' tag?", 2025-08-06/07, https://github.com/npm/cli/issues/8490
- [S8] GitHub Changelog, "Publishing with npm provenance from private source repositories is no longer supported", 2023-07-25, https://github.blog/changelog/2023-07-25-publishing-with-npm-provenance-from-private-source-repositories-is-no-longer-supported/
- [S9] npm/cli CHANGELOG (v12.2.0, 2026-09-30: "dist-tag: support OIDC authentication" #10038), https://raw.githubusercontent.com/npm/cli/v12.2.0/CHANGELOG.md ; npm/cli PR #7910 "fix!: publishing prerelease requires explicit tag", https://github.com/npm/cli/pull/7910 ; release dates from `https://registry.npmjs.org/npm` (`time`: 11.0.0 2024-12-16, 11.5.1 2025-07-24, 11.21.0 2026-09-30, 12.0.0 2026-07-08, 12.2.0 2026-09-30).
- [S10] npm/cli source: `lib/commands/publish.js`, `lib/commands/dist-tag.js`, `lib/utils/oidc.js`, `workspaces/libnpmpublish/lib/publish.js` at https://github.com/npm/cli (branch `latest`, v12.0.2), cross-checked against the installed npm 12.2.0.
- [S11] GitHub Docs, "OpenID Connect reference" (`repository_visibility` claim), https://docs.github.com/en/actions/reference/security/oidc ; "OpenID Connect", https://docs.github.com/en/actions/concepts/security/openid-connect
- [S12] npm/cli commit 7f72944 "fix(publish): accept publishConfig.tag to override highest semver check", 2025-01-17, https://github.com/npm/cli/commit/7f72944e43f009cf4d55ff4fe24c459e07f588fd ; npm/cli#8017 (bug report), https://github.com/npm/cli/issues/8017 ; npm v12 `package.json` engines.
- [S13] Community reports: npm/cli#8976 (private repo + provenance gives E422), https://github.com/npm/cli/issues/8976 ; npm/cli#8730 (OIDC E404 troubleshooting), https://github.com/npm/cli/issues/8730
- [S14] npm Docs, "npm Unpublish Policy", https://docs.npmjs.com/policies/unpublish
- [S15] npm Docs, "Deprecating and undeprecating packages or package versions", https://docs.npmjs.com/deprecating-and-undeprecating-packages-or-package-versions
- [S16] GitHub Docs, "Deployments and environments", https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
