# opencode-surplus

`opencode-surplus` is a Surplus provider integration for OpenCode. It keeps a
credential-free local copy of the public Surplus model inventory and exposes
only the exact models selected in your OpenCode provider configuration.

It supports:

- OpenCode V1 `>=1.18.29`
- the current OpenCode V2 plugin API
- one shared runtime-neutral inventory core with thin V1 and V2 adapters
- rich Surplus catalog metadata in V2 and a compatible down-map in V1
- cache-first startup with a one-hour refresh TTL and a manual refresh command

## Select models

Discovery never exposes every model automatically. Add the exact Surplus model
IDs you want to use.

### OpenCode V1

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-surplus"],
  "provider": {
    "surplus": {
      "models": {
        "deepseek-v4-flash": {},
        "minimax-m2.1": {
          "name": "MiniMax M2.1 (my label)"
        }
      }
    }
  }
}
```

### OpenCode V2

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-surplus"],
  "providers": {
    "surplus": {
      "models": {
        "deepseek-v4-flash": {},
        "minimax-m2.1": {}
      }
    }
  }
}
```

An empty `models` map intentionally leaves the Surplus provider loaded with
zero models. A model missing from a valid catalog is hidden and logged. Manual
model metadata wins over catalog metadata when both define the same property.

### Interactive model picker

The V2 TUI exposes **Select Surplus models** in the command palette and through
the `/surplus-models` slash command. It refreshes the public Surplus catalog,
provides searchable model names and IDs, supports multi-selection, and writes
the exact selection to the active project's `providers.surplus.models` map.
Cancel leaves the configuration unchanged; confirming with no models writes an
empty map.

For V1, use the version-neutral CLI picker. It uses the V1 native
`provider.surplus.models` map when the V1 config is detected:

```bash
opencode-surplus pick --version=v1
```

Use `--version=v2` to force the V2 config shape. The picker never stores or
requests an inference API key; catalog discovery remains public.

Configure Surplus credentials through OpenCode's normal provider
authentication. Catalog discovery is public and does not read or send the
inference API key.

## Endpoint and policy overrides

The default catalog endpoint is:

```text
https://api.surplusintelligence.ai/v1/models
```

The integration owns the Surplus provider defaults. Explicit endpoint settings
are retained for local proxies and testing:

- V1: `provider.surplus.options.baseURL`
- V2: `providers.surplus.settings.baseURL`

Advanced plugin options can change the cache TTL. V1 uses a tuple and V2 uses
an object:

```jsonc
// V1
{ "plugin": [["opencode-surplus", { "ttlHours": 6 }]] }

// V2
{ "plugins": [{ "package": "opencode-surplus", "options": { "ttlHours": 6 } }] }
```

The supported options are `ttlHours`, `ttlMs`, `endpoint`, and `cacheDir`.
The last two are intended for proxies, tests, and isolated environments.

## Cache and refresh behavior

The adapters share this cache:

```text
~/.cache/opencode/surplus-models.json
```

`XDG_CACHE_HOME` is honored. The cache is versioned, scoped to the normalized
Surplus endpoint, contains no credentials, and is written atomically. The
upstream fork's legacy `models-surplus.json` cache is imported opportunistically
and never written again.

At startup the integration loads a last-known-good inventory first. A fresh
cache avoids a request. A stale cache is used immediately while one bounded
10-second refresh runs in the background. A cache miss makes one bounded request
so the first session can be populated. There are no startup retries or
permanent interval timers.

Only a valid, non-empty catalog replaces the inventory. Empty, malformed, and
failed responses retain the last-known-good inventory. The V2 adapter reloads
the provider registry after a successful background refresh; V1 uses the fresh
cache on the next startup.

## Security and dependency monitoring

Picker and cache saves write a same-directory temporary file opened exclusively
with an unpredictable name. On POSIX systems, atomic writes reject destination
paths that traverse group- or world-writable directories unless sticky-directory
ownership protects the temporary entry. Windows ACLs are not checked. Existing
config permission bits are retained and newly created configs use owner-only
mode (`0600`). Failed writes before replacement leave the existing config in
place. If the prior mode cannot be restored after replacement, the save is
reported as successful with the safer owner-only mode retained.

The full normalized endpoint, including its path and query, determines cache
identity so separate proxies cannot share an inventory. Cache metadata and logs
contain the origin and an opaque fingerprint, not the configured path, query,
user information, or fragment. When loading an older canonical cache with a raw
path, the integration keeps its inventory available and attempts a secure
rewrite. If rewriting fails, it warns that the old disk cache may still contain
endpoint details. Remove `surplus-models.json` from the configured cache
directory (or `~/.cache/opencode/`) manually if the warning persists. Remove
any other old cache files from former cache directories manually; the
integration does not scan or rewrite caches it never loads.

CI fails when the production dependency tree has an npm advisory. It also
reports the full dependency audit, including development dependencies, as an
informational check so that development-only findings remain visible without
being mistaken for shipped runtime dependencies.

As checked on 2026-09-23, the development dependency tree contains
`@opentelemetry/core@2.6.1` through
`@opencode/plugin@2.0.11` -> `@opencode/util@2.0.11`; this is
affected by [CVE-2026-54285 / GHSA-8988-4f7v-96qf](https://github.com/open-telemetry/opentelemetry-js/security/advisories/GHSA-8988-4f7v-96qf),
fixed upstream in version 2.8.0. The production-only audit reported no
vulnerabilities. The latest checked `@opencode/plugin@2.0.14` also resolves
`@opentelemetry/core@2.6.1`, so no compatible upstream fix is available through
that host yet. This project does not force an unverified transitive override. The
full-audit CI step keeps the development advisory visible until a compatible
upstream update is available. GitHub Dependabot alerts were disabled for this
repository at the time of the scan; enabling them remains a repository-admin
follow-up.

## CLI

After installing the package, use the version-neutral CLI:

```bash
opencode-surplus list
opencode-surplus refresh
opencode-surplus pick [--version=v1|v2]
```

`list` shows the cached inventory and marks selected IDs. `refresh` performs one
public catalog request and updates the shared cache. `pick` opens a searchable
terminal picker, refreshes the catalog, and writes the selected native model
map to the active project config. The CLI reads the normal global/project
OpenCode config hierarchy; pass `--cache-dir=/path` to isolate its cache.
Neither command requires an API key.

## Development

```bash
npm install
npm run typecheck
npm run typecheck:test
npm test
npm run build
```

The repository also includes a minimal `Dockerfile` for running the test suite
without installing host dependencies:

```bash
docker build -t opencode-surplus-test .
docker run --rm opencode-surplus-test
```

## License and attribution

This modified fork is licensed under the GNU General Public License v3.0-only.
It is forked from
[`lprzychodzien/opencode-persistent-model-discovery`](https://github.com/lprzychodzien/opencode-persistent-model-discovery).
The upstream Git history and author attribution are retained.
