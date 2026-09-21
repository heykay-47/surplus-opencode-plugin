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

## CLI

After installing the package, use the version-neutral CLI:

```bash
opencode-surplus list
opencode-surplus refresh
```

`list` shows the cached inventory and marks selected IDs. `refresh` performs one
public catalog request and updates the shared cache. The CLI reads the normal
global/project OpenCode config hierarchy; pass `--cache-dir=/path` to isolate
its cache. Neither command requires an API key.

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
