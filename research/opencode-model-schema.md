# OpenCode V1/V2 model schema: reasoning, variants, attachments, temperature, tools

Research for heykay-47/surplus-opencode-plugin#3. Researched 2026-10-11.

## Scope and sources

- **V1 host:** `@opencode-ai/plugin` 1.18.31 and `@opencode-ai/sdk` 1.18.31 (installed), plus the host source at tag
  [`v1.18.31`](https://github.com/anomalyco/opencode/tree/v1.18.31) (commit `014614d3`).
- **V2 host:** `@opencode/plugin`, `@opencode/schema` and `@opencode/ai` 2.0.22 (installed), plus the host source at
  tag [`v2.0.22`](https://github.com/anomalyco/opencode/tree/v2.0.22) (commit `527f0b93`).
- `github.com/sst/opencode` now redirects to `anomalyco/opencode` (checked with `gh api repos/sst/opencode`).
- **V1 wire format:** `@ai-sdk/openai-compatible` 2.0.41. V1 pins this version in `packages/opencode/package.json` and
  carries a patch that only changes how errors are reported.
- **Surplus catalog:** `GET https://api.surplusintelligence.ai/v1/models`, fetched 2026-10-11T15:53Z.

How citations are written:

- `pkg:` is an installed file under `node_modules/`.
- `v1:` is a path under `packages/` at tag v1.18.31.
- `v2:` is a path under `packages/` at tag v2.0.22.
- `plugin:` is a path in this repository.

Every bullet is **Fact** (read directly in a cited source) unless it is marked **Inference**.

## Summary

| Concern | V1 field (config `provider.<id>.models.<id>`) | What V1 does with it | V2 field (`Model.Info`) | What V2 does with it |
|---|---|---|---|---|
| Reasoning support | `reasoning: boolean` becomes `capabilities.reasoning` | Gates the default effort variants. Turns on the reasoning indicator in the TUI and the app tooltip. | No field | The TUI treats `variants.length > 0` as "reasoning". Reasoning deltas are always parsed. |
| Effort variants | `variants: Record<id, {disabled?, ...options}>` | Defaults are derived from `reasoning` and the package. The selected variant's options are merged into the AI SDK `providerOptions`. `reasoningEffort` becomes `reasoning_effort`. | `variants: {id, settings?, headers?, body?}[]` | Only an explicit list counts. The selected variant's `settings`, `headers` and `body` are overlaid on the model. `settings.reasoningEffort` becomes `reasoning_effort`. |
| Attachments / vision | `attachment: boolean`, `modalities.input[]` (enum text, audio, image, video, pdf) | The real gate is `capabilities.input.*`. Media that is not allowed is replaced with an `ERROR: Cannot read …` text part. No consumer of `attachment` was found. | `capabilities.input: string[]` | Same replacement, based on a prefix match against `capabilities.input`. |
| Temperature | `temperature: boolean` | When false, no temperature is sent. When true, the agent's `temperature` (or a built-in per-model default) is sent. | No field. V2 config flags a model-level `temperature` as unsupported. | Sent only if a session request hook sets `options.temperature`. |
| Tool calling | `tool_call: boolean`, mapped to `capabilities.toolcall` (default true) | Stored and exposed, but no host consumer was found. | `capabilities.tools: boolean` | Stored. The app maps it to `toolcall`. No core consumer was found. |
| Reasoning replay field | `interleaved: bool \| field \| {field}` | Puts reasoning text back on assistant messages under that field. | `compatibility.reasoningField` and `requireReasoning` | Same idea, applied in the `@opencode/ai` OpenAI-chat lowering. |
| Reload after startup | No provider-reload hook | The registry is built once per instance. The only reload is disposing the instance. | `ctx.provider.reload()` | Rebuilds the provider and model fold. The plugin already uses it. |

---

## 1. V1 (1.18.31)

### 1.1 Schema fields

- The config model schema has `attachment`, `reasoning`, `temperature`, `tool_call`, `interleaved`,
  `modalities.{input,output}`, `options`, `headers` and `variants` (each variant may set `disabled`).
  - Sources: `v1: core/src/v1/config/provider.ts` (`Model`, lines 13–75); `pkg: @opencode-ai/sdk/dist/v2/gen/types.gen.d.ts`
    (`ProviderConfig.models`, lines 1380–1463).
  - The older `pkg: @opencode-ai/sdk/dist/gen/types.gen.d.ts` `ProviderConfig` (lines 878–937) has no `variants` or
    `interleaved`. The plugin's `Config` type is built on that older type (`pkg: @opencode-ai/plugin/dist/index.d.ts`,
    line 48). **Inference:** the typed config used by the plugin hook does not list `variants`, even though the host
    accepts and uses them.
- Allowed modality values are `"text" | "audio" | "image" | "video" | "pdf"` (same sources). Surplus also reports
  `"file"`, which is not in this list.
- The runtime `Provider.Model` has these capabilities: `temperature`, `reasoning`, `attachment`, `toolcall`,
  `input.{text,audio,image,video,pdf}`, `output.{…}` and `interleaved`. It also has
  `variants?: Record<string, Record<string, unknown>>`.
  - Sources: `pkg: @opencode-ai/sdk/dist/v2/gen/types.gen.d.ts` (`Model`, lines 1653–1732); `v1: opencode/src/provider/provider.ts`
    (`Capabilities` schema around lines 1030–1041; `variants` at line 1091).

### 1.2 How a config-defined model is built (this plugin's path)

The plugin writes `config.provider.surplus` from its `config` hook (`plugin: src/v1.ts` `configure`) with
`npm: "@ai-sdk/openai-compatible"`. Surplus is not a models.dev provider: 226 providers were checked on 2026-10-11 and
none matched `surplus`. So the model is parsed by the "extend database from config" branch of
`v1: opencode/src/provider/provider.ts` (from line 1481):

- The capabilities are copied from the config fields (lines 1520–1548):
  - `reasoning ?? false`
  - `temperature ?? false`
  - `attachment ?? false`
  - `tool_call ?? true`
  - `input.text = modalities.input.includes("text") ?? true`
  - `input.image`, `input.pdf` and the other media inputs: `includes(...) ?? false`
  - `interleaved ?? false`, except for `@ai-sdk/openai-compatible` model ids that contain `deepseek`, which get
    `{field: "reasoning_content"}`.
- **Consequence today (Fact):** `toV1Model` (`plugin: src/core.ts`, lines 492–519) emits only `id`, `name`, `limit`, `cost`
  and `capabilities: {tools}`. Neither `capabilities` nor `tools` is a V1 config key; the V1 key is `tool_call`. So every
  Surplus model in V1 ends up with:
  - `reasoning=false`, `temperature=false`, `attachment=false`
  - `input.image=false`, `input.pdf=false`
  - no variants
- **Variants** (lines 1568–1577) are computed like this:
  1. Start from `ProviderTransform.variants(parsedModel)`.
  2. `mergeDeep` the config `variants` on top.
  3. Drop entries with `disabled: true`.

  So variants from config add to or override the defaults. To remove a default variant, mark it `disabled: true`.
  - After all sources are loaded, models whose `variants` is still `undefined` get `ProviderTransform.variants(model)`
    (lines 1701–1712).

### 1.3 Default effort variants for `@ai-sdk/openai-compatible`

From `v1: opencode/src/provider/transform.ts`, `variants()` (line 777):

- If `capabilities.reasoning` is false, there are no variants (line 778).
- These model ids (lower-cased) get **no** variants even when `reasoning` is true (lines 829–840): ids containing
  - `deepseek-chat`, `deepseek-reasoner`, `deepseek-r1`, `deepseek-v3`
  - `minimax`
  - `glm` (except GLM-5.2)
  - `kimi`, `k2p`
  - `qwen`
  - `big-pickle`
- Other ids with `@ai-sdk/openai-compatible` get `low`, `medium` and `high` as `{reasoningEffort: <effort>}`.
  Ids containing `deepseek-v4` also get `max`, and `north-mini-code` gets `none`/`high` (lines 981–989).
- **Inference:** many Surplus ids (for example `qwen3-235b-a22b-2507`, `kimi-*`, `glm-*`) would get no automatic variants
  in V1 even with `reasoning: true`. The plugin would have to emit `variants` explicitly to offer effort levels for them.

### 1.4 What reaches the wire (openai-compatible)

- **Selected variant:** `v1: opencode/src/session/llm/request.ts` lines 80–92 merge the options in this order:
  1. `ProviderTransform.options(...)`
  2. `model.options`
  3. `agent.options`
  4. the selected variant (`model.variants[user.model.variant]`)
- **Provider-options key:** `ProviderTransform.providerOptions` (`transform.ts` lines 1408–1460) puts these options under
  a key named after the provider: for `@ai-sdk/openai-compatible` it is `providerID.split(".")[0]`, so `surplus`.
  - The SDK is created with `name: model.providerID` (`provider.ts`, around lines 1835 and 1858).
- **SDK behaviour:** `@ai-sdk/openai-compatible` 2.0.41
  ([`openai-compatible-chat-language-model.ts`](https://github.com/vercel/ai/blob/%40ai-sdk/openai-compatible%402.0.41/packages/openai-compatible/src/chat/openai-compatible-chat-language-model.ts),
  checked from the npm tarball, lines 103–105, 146–163 and 230–244):
  - It reads `providerOptions[<name>]`, so `reasoningEffort` is sent as **`reasoning_effort`** and `textVerbosity` as
    `verbosity`.
  - Any other key is **spread verbatim into the request body**. A variant such as `{include_reasoning: true}` or
    `{reasoning: {...}}` would therefore reach Surplus unchanged.
- **Temperature:** `request.ts` lines 123–126 pass `temperature` to the `chat.params` hook as
  `capabilities.temperature ? (agent.temperature ?? ProviderTransform.temperature(model)) : undefined`.
  - `ProviderTransform.temperature` (`transform.ts` line 527) returns a value only for some ids (Claude, Gemini,
    GLM-4.6/4.7, MiniMax-M2, Kimi-K2, north-mini-code). For other ids it returns `undefined`.
  - **Inference:** for most Surplus models, `temperature: true` only matters when the user sets an agent
    `temperature`. A plugin can still override the value in the `chat.params` hook
    (`pkg: @opencode-ai/plugin/dist/index.d.ts`, lines 203–215).
- **Attachments:** `unsupportedParts` (`transform.ts` lines 409–440) replaces any image or file part whose modality is
  false in `capabilities.input` with the text
  `ERROR: Cannot read <name> (this model does not support <modality> input). Inform the user.`
  - **Inference:** Surplus models in V1 currently cannot receive images, because `input.image` defaults to false.
- **`attachment` and `toolcall`:** a grep of `v1: opencode/src`, `tui/src`, `app/src` and `core/src` found no consumer
  besides the mapping code and the built-in Modal and Copilot model loaders.
  - **Inference:** in 1.18.31 these flags are informational. Tools are sent whatever `tool_call` says. This is a
    negative grep result, not proof.
- **Reasoning replay:** `interleaved: {field}` puts the joined reasoning text onto the assistant message as
  `providerOptions.openaiCompatible[field]` (`transform.ts` lines 321–350).

### 1.5 UI behaviour

- The TUI's model status shows `reasoning` from `capabilities.reasoning` (`v1: tui/src/context/local.tsx` line 272).
- The variant list is `Object.keys(model.variants)`, with `variant.cycle` (lines 380–403). The `variant_cycle` keybind
  defaults to `ctrl+t` (`v1: tui/src/config/keybind.ts` line 132), and `/variants` shows "No variants available" when
  the list is empty (`v1: tui/src/app.tsx` lines 719–724).
- The app's model tooltip lists the input modalities and allowed/none reasoning from `capabilities`
  (`v1: app/src/components/model-tooltip.tsx` lines 73–92).
- The docs describe built-in and custom variants and the `variant_cycle` keybind, with a config example using
  `variants.<id>.reasoningEffort` and `disabled: true` (<https://opencode.ai/docs/models/>, sections "Variants" and
  "Custom variants"; the page said "Last updated: Oct 10, 2026").

### 1.6 Reference: the built-in Modal loader maps the same catalog shape

`v1: opencode/src/plugin/modal/models.ts` (lines 85–130) maps an OpenRouter-style `/models` response, the same shape
Surplus uses:

- `supported_sampling_parameters.includes("temperature")` → `temperature`
- `supported_features.includes("reasoning")` → `reasoning`
- any non-text `input_modalities` → `attachment`
- `supported_features.includes("tools")` → `toolcall`
- `input_modalities` → `input.*`
- `reasoning_options[{type:"effort", values}]` → variants `{<effort>: {reasoningEffort}}`

This is first-party precedent for mapping Surplus `supported_features` and `supported_parameters`.

### 1.7 Is there a V1 seam to reload provider models after startup?

There is **no dedicated seam.**

- `Hooks` (`pkg: @opencode-ai/plugin/dist/index.d.ts`, lines 173–322) has no reload or refresh member.
- The provider registry is an `InstanceState`: a `ScopedCache` keyed by directory, computed lazily on first read and
  invalidated only when the instance is disposed.
  - Sources: `v1: opencode/src/provider/provider.ts` line 1400; `v1: opencode/src/effect/instance-state.ts` lines 26–66.
- `ProviderHook.models` (`index.d.ts` lines 167–170) is called only while that state is being built
  (`provider.ts` lines 1454–1478). It also does nothing for this plugin:
  - It is applied only when `database[providerID]` exists, and `database` is built from models.dev only (line 1406).
  - The config providers are merged after it (line 1481), and Surplus is not on models.dev.
- The `config` hook is awaited once at plugin init (`v1: opencode/src/plugin/index.ts` lines 244–252). The plugin's
  background refresh mutates the same `cfg.provider.surplus.models` object later (`plugin: src/v1.ts`).
  - **Inference:** that change is seen only if the provider state is first read after the refresh lands. Otherwise it
    waits for the next instance load. This matches the current "next startup" behaviour.
- **Workable but heavy seam:** `PluginInput.client.instance.dispose()` (`POST /instance/dispose`).
  - Sources: `pkg: @opencode-ai/sdk/dist/gen/sdk.gen.d.ts` lines 88–92; handler at
    `v1: opencode/src/server/routes/instance/httpapi/handlers/instance.ts` lines 24–27.
  - It marks the instance for teardown after the response. The TUI re-bootstraps on `server.instance.disposed`
    (`v1: tui/src/context/sync.tsx` line 178), and the app reacts the same way
    (`v1: app/src/context/global-sync/event-reducer.ts` line 127).
  - `POST /global/dispose`, and a global config update that changes something, dispose *all* instances
    (`handlers/global.ts` lines 78–87).
  - **Inference:** disposing re-runs plugin init, so the `config` hook would see the fresh cache. It also tears down
    every instance-scoped service (plugins, MCP, LSP and the rest), so it is much heavier than a model refresh. Its
    effect on in-flight sessions was **not verified**.
- `@opencode-ai/plugin` 1.18.31 also ships `./v2/*` exports with a `CatalogDraft` transform
  (`pkg: @opencode-ai/plugin/dist/v2/effect/catalog.d.ts`).
  - The V1 runtime's plugin loader validates only `server`/`tui` exports (`v1: opencode/src/plugin/shared.ts` lines
    283–297).
  - **UNCONFIRMED:** whether the 1.18.31 V1 runtime activates `v2` plugin shapes at all. Nothing found shows that it
    does.

---

## 2. V2 (2.0.22)

### 2.1 Schema fields

`pkg: @opencode/schema/dist/model.js`:

- `Model.Info` fields: `id`, `modelID`, `providerID`, `canonical?`, `family?`, `name`, `compatibility?`, `package?`,
  `settings?`, `headers?`, `body?`, `capabilities`, `variants`, `time.released`, `cost[]`, `status`, `enabled`,
  `limit`. The default instance is at lines 113–125.
- `Capabilities` is `{tools: boolean, input: string[], output: string[]}` (lines 62–70). It defaults to
  `{tools: true, input: ["text","image"], output: ["text"]}`.
  - There is **no `reasoning`, `temperature` or `attachment` field.**
- `Variant` is `{id, settings?, headers?, body?}` (lines 83–86). Model refs carry the variant as
  `provider/model#variant` (`Model.Ref.parse`, lines 11–34).
- `Compatibility` has `reasoningField`, `requireReasoning`, `maxTokensField`, `requireFinishReason`,
  `requireAssistantAfterTool` and `supportsPromptCacheKey` (lines 53–61).
- Config models (`pkg: @opencode/schema/dist/config/provider.js`, lines 54–77) accept partial `capabilities` and
  `variants: {id, settings?, headers?, body?}[]`.
- The V2 config normalizer marks the V1 model keys `release_date`, `attachment`, `reasoning`, `temperature` and
  `experimental` as unsupported (`v2: core/src/config/normalize.ts` line 55).
- The V1 to V2 migration maps `tool_call`/`modalities` to `capabilities` and the `variants` record to an array
  (`v2: core/src/v1/config/migrate.ts` lines 325–345).

### 2.2 Variants: generation, ordering, and the plugin's `variants: []`

- `Variant.resolve(model, supports = [{type: "effort"}])` (`v2: core/src/variant.ts` lines 16–25) picks a protocol by
  `model.package`. For `@opencode/ai/providers/openai-compatible` the protocol is `openaiCompatible` → `openaiChat`
  (lines 77–80, 218–221 and 569). It produces `low`, `medium` and `high` as `{settings: {reasoningEffort}}`.
  - This does **not** check any reasoning flag.
- models.dev models get variants only from `reasoning_options` (`v2: core/src/models-dev.ts` lines 105 and 186–192).
- The config provider plugin (`v2: core/src/config/plugin/provider.ts`):
  - It merges a configured model's `variants` into the existing list by id (lines 122–136).
  - If config has no `variants` **and** there is no source base model, it sets
    `model.variants = Variant.resolve(...)` (lines 151–159).
  - It is a **post** internal plugin (`v2: core/src/plugin/internal.ts` lines 249–267). It activates after host,
    instance and package plugins (`v2: core/src/plugin/supervisor.ts` lines 91–95 and 141–152). Transforms are
    re-applied in registration order (`v2: core/src/state.ts` lines 18–21).
- **Inference:** because this plugin's provider transform registers first and adds the Surplus models, the config
  plugin sees them as `base`. So the plugin's `variants: []` is kept and the user sees no effort variants.
  - Edge case: if there is no inventory, the plugin adds no model for a configured id, and the config plugin then
    creates a default model with `low`/`medium`/`high` (lines 151–159).
- **UI:**
  - The V2 TUI treats a model as "reasoning" when `variants.length !== 0` (`v2: tui/src/context/local.tsx` line 409).
  - It lists variants for `variant.cycle` (`ctrl+t`) (`local.tsx` line 483; `v2: tui/src/config/keybind.ts` line 174).
  - Title generation prefers a `none`, `minimal` or `low` variant when one exists (`v2: core/src/session/context.ts`
    lines 104–105 and 186).

### 2.3 What reaches the wire (openai-compatible)

1. `withVariant` (`v2: core/src/model-resolver.ts` lines 136–160) overlays the variant's `settings`, `headers` and
   `body` on the model.
2. For non-AI-SDK packages, `resolveCatalogModel` (lines 195–240) calls
   `module.model(modelID, {...settings, headers, body})`.
3. `@opencode/ai/providers/openai-compatible` `model()` (`pkg: @opencode/ai/dist/providers/openai-compatible.js`,
   lines 25–32) treats the remaining settings as `providerOptions` and `body` as `http.body`.
4. `resolveRequestOptions` merges route, model and request `providerOptions` (`pkg: @opencode/ai/dist/route/client.js`,
   lines 68–78).
5. `OpenAIChat.lowerOptions` sends `reasoning_effort` when `providerOptions.reasoningEffort` is set
   (`pkg: @opencode/ai/dist/protocols/openai-chat.js`, lines 618–633).

Other details of the wire format:

- Only known option keys survive decoding: `store`, `reasoningEffort`, `reasoningSummary`, `include`,
  `textVerbosity`, `serviceTier` and the rest (`pkg: @opencode/ai/dist/protocols/utils/open-responses-options.js`,
  lines 34–60).
  - **Inference:** arbitrary Surplus parameters such as `include_reasoning` belong in a variant or model `body`, not in
    `settings`.
- Accepted effort strings are `none`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`
  (`pkg: @opencode/ai/dist/schema/options.js` line 117).
  - Switching between effort-named variants inserts `Message.effort` markers
    (`v2: core/src/session/runner/to-llm-message.ts` lines 232–247).
  - Routes without `supportsEffortUpdates` strip those markers (`pkg: @opencode/ai/dist/effort-updates.js` line 14).
- **Temperature:** `fromRequest` sends `temperature: generation?.temperature` (`openai-chat.js` lines 634–671).
  `generation` is built only from the request options returned by the session request hooks
  (`v2: core/src/session/model-request.ts` lines 248–296; hook type `SessionRequestOptions` in
  `pkg: @opencode/plugin/dist/promise/session.d.ts` lines 20–28).
  - **Inference:** a grep of `v2: core/src` found no default temperature source, so V2 sends no temperature unless a
    plugin hook sets one.
- **Reasoning output:** `reasoningDelta` reads `reasoning_content`, `reasoning` and `reasoning_text` (plus a configured
  `compatibility.reasoningField`) whatever the variants are (`openai-chat.js` line 756).
  - `compatibility.reasoningField` and `requireReasoning` control how reasoning is replayed on assistant messages
    (lines 391–420).
- **Attachments:** `unsupportedMedia` (`v2: core/src/session/model-request.ts` lines 121–135) replaces a media part with
  the same `ERROR: Cannot read …` text unless some entry of `capabilities.input` starts with the part's modality
  (image, audio, video or pdf).
  - **Inference:** the plugin's current pass-through of Surplus `input_modalities` enables images. Surplus `"file"`
    never matches `pdf`, so PDFs are rejected. Mapping `file_input`/`"file"` to `"pdf"` would be a product decision.
- **Tools:** `capabilities.tools` is set from catalogs (`v2: core/src/models-dev.ts` lines 221–224; Modal at
  `v2: core/src/modal/models.ts` line 115). The app maps it to `toolcall` for display
  (`v2: app/src/runtime/server/global-sync/utils.ts` line 82).
  - **Inference:** a grep of `v2: core/src` found no code that withholds tools based on it.

### 2.4 Reload

`ctx.provider.reload()` is a `ProviderDomain` member (`pkg: @opencode/plugin/dist/promise/provider.d.ts`). It
invalidates the fold, so the plugin's transform runs again. `plugin: src/v2.ts` already calls it after a refresh.

---

## 3. Surplus catalog facts relevant to mapping (snapshot 2026-10-11)

Of 430 entries, 238 list `text` among their output modalities. Among those 238:

| Signal | Models |
|---|---|
| `supported_features` contains `reasoning` | 151 |
| `supported_parameters` contains `reasoning` | 138 |
| `supported_parameters` contains `reasoning_effort` | 59 |
| `reasoning` feature but no `reasoning_effort` parameter | 94 |
| `reasoning_effort` parameter but no `reasoning` feature | 2 |
| `supported_parameters` contains `include_reasoning` | 136 |
| `supported_features` contains `vision` | 120 |
| `architecture.input_modalities` contains `image` | 90 |
| `vision` feature but no `image` input modality | 30 |
| `input_modalities` contains `file` | 31 |
| `supported_features` contains `file_input` | 6 |
| `supported_parameters` contains `temperature` | 208 |
| `supported_features` contains `tools` | 170 |
| `supported_parameters` contains `tools` | 211 |

- The catalog has **no list of allowed effort values**. Its top-level keys include `supported_parameters`,
  `supported_features` and `architecture`, but nothing like Modal's `reasoning_options`.
- Example: `qwen3-235b-a22b-2507` lists `reasoning_effort` and `reasoning` in `supported_parameters`, but its
  `supported_features` are only `["streaming","tools"]`.

## 4. Implications for this plugin (Inference / recommendation)

1. **V1:** `toV1Model` should emit V1 keys, not `capabilities`:
   - `reasoning` from the `reasoning` feature or the `reasoning`/`reasoning_effort` parameters
   - `temperature` from `supported_parameters`
   - `tool_call` from `tools`/`tool_choice`
   - `modalities.input` filtered to the V1 enum, and `attachment` set when any non-text input exists

   Without `modalities.input`, images are always rejected in V1.
2. **Effort variants:** emit them explicitly only when `reasoning_effort` is supported, for example
   `{low: {reasoningEffort: "low"}, medium: …, high: …}` in V1 and `[{id: "low", settings: {reasoningEffort: "low"}}, …]`
   in V2. This avoids V1's id skip list (qwen, kimi, glm, …) and V2's reasoning-agnostic default. The effort set
   (`low`/`medium`/`high`) is a guess, because Surplus does not publish allowed values.
3. **V1, reasoning without effort control:** with `reasoning: true` and no `reasoning_effort` support, V1 still
   auto-generates `low`/`medium`/`high` unless the id is on the skip list. Suppress them with `disabled: true`
   entries, or leave `reasoning` false for such models.
4. **V1 refresh:** the only V1 refresh options are the current behaviour (next startup) or
   `client.instance.dispose()`. The second is heavy and its side effects on running sessions are unverified.

## 5. Unknowns

- Which effort values each Surplus model actually accepts, and whether Surplus maps `reasoning_effort` onto each
  upstream model's own thinking control.
- Whether Surplus requires `include_reasoning: true` to return reasoning text. Its parameter is listed for 136 models,
  but the default behaviour was not tested; no requests were made with a key.
- The effect of `POST /instance/dispose` on in-flight V1 sessions and on the TUI session view, beyond the
  re-bootstrap.
- Whether V1 1.18.31 activates `@opencode-ai/plugin/v2` plugin shapes. Nothing found indicates that it does.
- The "no consumer" results for V1 `attachment`/`toolcall` and V2 `capabilities.tools` come from greps of the tagged
  sources and could miss indirect uses.
