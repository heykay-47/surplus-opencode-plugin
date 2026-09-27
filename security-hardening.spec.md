# Harden Surplus inventory and model picker against local disclosure and untrusted input

Baseline: `opencode-surplus` 0.3.0 at commit `7fca965`. This spec covers the findings from the 2026-09-23 security scan. It is intended as a single implementation handoff, not a claim that the findings are already fixed.

## Problem Statement

The Surplus model picker replaces an OpenCode config with a newly created temporary file. Under umask `022`, a private `0600` config becomes `0644` after a save. A config containing credentials can become readable by other local users if they can traverse its directory. The picker and Surplus model inventory cache also write predictable, non-exclusively opened temporary files, allowing conditional symlink clobbering when an attacker can write in the target directory. An explicit proxy endpoint with a credential in its URL path puts that path in the cache and logs. An attacker-controlled Surplus model inventory can place terminal control characters in CLI output.

The development dependency tree contains `@opentelemetry/core@2.6.1`, which matches CVE-2026-54285. `npm audit` reports 11 moderate package findings caused by that one advisory; `npm audit --omit=dev` reports zero. This plugin does not bundle the affected host package as a runtime dependency. The repository's Dependabot alerts are disabled, so the project lacks that alert channel.

## Solution

Saving model selection must not expose existing config secrets or allow a competing local process to redirect temporary writes. The Surplus model inventory cache must keep its cache-first behavior without storing configured endpoint path or query text. Logs must not include those components. The CLI must display untrusted catalog text without letting it control the terminal, while preserving exact model IDs for selection and configuration. Maintain a documented, checked dependency posture without forcing an untested host dependency override.

Acceptance is based on observable behavior at the existing picker-save, inventory-store, and CLI seams. Address confirmed defects first. Treat the development-only CVE and the repository alert setting as separate, explicitly reported follow-ups if a compatible dependency update or repository administration is unavailable.

## User Stories

1. As a user with a private OpenCode config, I want a picker save to retain its restrictive permissions, so that other local users cannot read my credentials.
2. As a user creating a new config through the picker, I want it private by default, so that adding credentials later does not require fixing its mode first.
3. As a user with an existing config, I want my selected Surplus model IDs and other settings preserved, so that security changes do not alter the model selection contract.
4. As a V1 user, I want the CLI picker to keep writing the V1 native model map, so that selected models remain available.
5. As a V2 user, I want the TUI picker to keep writing the V2 native model map, so that selected models remain available.
6. As a user who cancels the picker, I want no config write, so that a canceled choice cannot change my settings or their permissions.
7. As a user sharing a writable directory, I want temporary config and cache writes to resist pre-planted files or symlinks, so that a peer cannot redirect or clobber another file.
8. As a user whose write fails, I want the old config or cache to remain usable and failed temporary files removed, so that a partial save does not destroy known-good data.
9. As a user of a proxy endpoint, I want URL paths and query strings absent from logs and persisted cache metadata, so that path-based credentials are not copied there.
10. As a user switching between proxy paths or queries on one origin, I want inventories to remain distinct, so that one catalog is never mistaken for another.
11. As a user with a prior cache, I want the cache-first and last-known-good inventory behavior retained, so that an outage does not remove usable selected models.
12. As a CLI user, I want catalog-supplied text displayed safely, so that a malicious name or ID cannot forge terminal lines or control my terminal.
13. As a CLI user, I want my chosen exact model ID persisted unchanged, so that escaping its display does not change which model is selected.
14. As a maintainer, I want each dependency alert tied to the affected package and usage, so that 11 propagated findings are not mistaken for 11 different CVEs.
15. As a maintainer, I want an actionable CI dependency check, so that newly introduced runtime advisories fail verification while the known development-only advisory remains visible.
16. As a maintainer, I want CI jobs to run with minimal repository permissions, so that untrusted pull requests cannot use unnecessary credentials.

## Implementation Decisions

- Keep the accepted Surplus integration boundaries: a shared runtime-neutral inventory core, thin V1/V2 adapters, a public unauthenticated catalog request, and OpenCode-owned inference authentication. Do not add a plugin-managed credential store.
- Keep the native exact-ID model selection contract, including empty selection meaning no discovered models. Do not modify the OpenCode authentication flow or change the picker to select every discovered model.
- For an existing config, save through a private temporary file opened exclusively and preserve its previous permission bits on successful replacement. Never make a private config more permissive. For a newly created config, use owner-only permissions regardless of umask. Keep the save atomic and clean up a temporary file on failure without deleting or overwriting the old config.
- Use unpredictable names and exclusive creation for both config and canonical cache temporary writes. Change the current injectable filesystem boundary only as much as needed to test the secure write. A collision or failed rename must not write through a symlink or discard the previous good file.
- Keep per-endpoint cache identity for different origins, paths, and queries, but store no literal URL path, query, userinfo, or fragment in persisted cache identity or endpoint metadata. Logs should identify an endpoint without emitting those values. The default Surplus endpoint remains unchanged.
- On loading a prior canonical cache that contains an endpoint path, verify its identity against the configured endpoint, keep its inventory available in memory, and securely rewrite it without the raw path. If that rewrite fails, preserve the in-memory inventory and surface a path-free warning; do not claim the disk copy is scrubbed. Document manual cleanup for old cache files never loaded or successfully rewritten.
- Escape untrusted catalog ID, name, description, and other displayed fields at the CLI output boundary. Keep the underlying ID unchanged for search, toggling, native model-map persistence, and both adapters. Preserve intentional CLI separators and line breaks.
- Treat CVE-2026-54285 / GHSA-8988-4f7v-96qf as a development-chain advisory in the currently locked tree. Prefer a compatible upstream dependency release that resolves `@opentelemetry/core` to `2.8.0` or later; do not force a transitive override without checking compatibility and the V1/V2 verification matrix. If no compatible fix exists, record the residual advisory and its upstream blocker rather than asserting a clean audit.
- Add a CI check for production dependency advisories and make the development advisory status visible. Set explicit read-only repository permissions and avoid persisting checkout credentials if the CI job does not need them. Retain support-floor and current-release compatibility coverage; do not silently replace a current-release test with a permanently pinned host version.
- Document the permission guarantees, the fact that custom URL path/query text is not persisted or logged after remediation, any old-cache cleanup, and the residual dev-only advisory if still present. Do not put secret examples into repository content.

## Testing Decisions

- Prefer observable effects at existing seams to private-helper tests. Existing picker tests already exercise real temporary project configs, inventory tests use temporary caches and a local HTTP fixture, and CLI tests exercise command output. Reuse those seams rather than adding a new test-only abstraction.
- With a restrictive umask and a traversable fixture directory, save an existing `0600` config containing a synthetic secret through V1 and V2 picker persistence. Assert that the resulting mode stays `0600`, the content remains correct, and the old file remains intact on a simulated write or rename failure. Also assert a new config is `0600`. Use temporary directories and clean up fixtures.
- Pre-place or race a would-be temporary filename with a symlink in a temporary writable fixture. Verify neither picker nor cache writes to its target; verify a failed operation leaves the original good file and no abandoned temporary file. Use a deterministic filesystem seam or a controlled collision instead of timing-dependent tests.
- Refresh the Surplus model inventory against a local response with an explicit synthetic endpoint whose path and query differ from a second endpoint on the same origin. Inspect the persisted cache and captured logs for absence of the synthetic path/query; verify the endpoints cannot reuse each other's inventories. Cover a prior-format cache and failed refresh without dropping last-known-good inventory.
- Supply catalog IDs and names containing escape sequences, carriage returns, newlines, tabs, and Unicode directional controls to the CLI fixture. Assert that output contains no active control sequences from those fields and that a selected ID is persisted byte-for-byte unchanged. Cover list and interactive pick where the existing tests can drive input reliably.
- Run the source and test typechecks, unit/fixture tests, build, package dry-run, and the V1/V2 compatibility matrix. Run `npm audit --omit=dev` and the full audit. Zero production findings is required; a remaining development finding must be documented with the advisory ID, locked version, and reason a compatible fix was not adopted. Do not mark this CVE resolved merely because the production-only audit is clean.

## Out of Scope

- Changing Surplus's public API, the OpenCode host's own dependency tree, authentication or inference credentials, or the native model-selection contract.
- Blocking explicitly configured proxy endpoints, inventing a new cache service, or rewriting the existing JSON/JSONC formatting policy of the picker.
- Promising that an endpoint credential already copied into an old cache file elsewhere on a user's disk can be removed remotely.
- Changing the GitHub repository's visibility or enabling Dependabot in repository settings without an administrator's separate authorization. Keep alert enablement as a follow-up if access is not available.
- Guaranteeing the absence of unpublished CVEs or vulnerabilities in separately installed OpenCode hosts.

## Further Notes

- Source landmarks at the baseline commit: picker persistence in `src/config.ts`, canonical cache and endpoint handling in `src/core.ts`, CLI listing and picker output in `src/cli.ts`, CI in `.github/workflows/ci.yml`, and prior-art tests in `test/picker.test.ts`, `test/core.test.ts`, and `test/cli.test.ts`.
- The security scan reproduced an existing `0600` config becoming `0644` under umask `022`. The cached path leak requires an explicitly configured proxy path; the symlink case requires an attacker-writable target directory; terminal injection requires attacker-controlled catalog or cache content. The public catalog request itself has no Authorization header.
- Official advisory: https://github.com/open-telemetry/opentelemetry-js/security/advisories/GHSA-8988-4f7v-96qf . CVE record: https://www.cve.org/CVERecord?id=CVE-2026-54285 . The upstream advisory was published 2026-06-12; affected `@opentelemetry/core` versions are below `2.8.0`. As checked 2026-09-23, even `@opencode/plugin@2.0.14` still pins OpenTelemetry `2.6.1`. The defect requires processing oversized attacker-controlled baggage and affects availability, not confidentiality.
- GitHub reported this repository private and Dependabot alerts disabled at the time of the scan. A local lockfile audit is not a substitute for examining a user's separately installed OpenCode host.
