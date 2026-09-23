import type { Context, Plugin as V2Plugin } from "@opencode/plugin/promise/plugin"
import {
  DEFAULT_ENDPOINT,
  PLUGIN_ID,
  PROVIDER_ID,
  PROVIDER_NAME,
  SurplusInventoryStore,
  configuredModelIds,
  configuredModelValue,
  resolveRuntimeOptions,
  safeEndpointForLog,
  selectedCatalogModels,
  ttlMilliseconds,
  toV2Model,
  type Inventory,
  type CatalogModel,
  type LogEvent,
  type RuntimeOptions,
} from "./core.js"

type ProviderEditor = Parameters<Parameters<Context["provider"]["transform"]>[0]>[0]
type ProviderRecord = NonNullable<ReturnType<ProviderEditor["get"]>>
type ModelInfo = Parameters<ProviderEditor["models"]["set"]>[1][number]
type ProviderInfo = Parameters<ProviderEditor["add"]>[0]["info"]
type Source = Pick<ProviderRecord, "provider" | "models">

function createLogger() {
  return (event: LogEvent) => console.log(JSON.stringify(event))
}

function snapshotSource(source: ProviderRecord | undefined): Source | undefined {
  if (!source) return undefined
  return {
    provider: { ...source.provider, settings: source.provider.settings ? { ...source.provider.settings } : undefined },
    models: new Map(source.models),
  }
}

function providerInfo(source: Source | undefined, endpoint: string, emptyProvider: () => ProviderInfo): ProviderInfo {
  const info: Record<string, any> = source?.provider ? { ...source.provider } : { ...emptyProvider() }
  info.id = PROVIDER_ID
  info.name ||= PROVIDER_NAME
  info.activation ||= "enabled"
  info.package ||= "@opencode/ai/providers/openai-compatible"
  info.settings = { ...(info.settings || {}), baseURL: info.settings?.baseURL || endpoint }
  return info as ProviderInfo
}

function modelList(
  source: Source | undefined,
  inventory: Inventory | undefined,
  createModel: (model: CatalogModel) => ModelInfo,
): ModelInfo[] {
  const configuredModels = source?.models || new Map<string, ModelInfo>()
  const selectedIds = configuredModelIds(configuredModels)
  if (selectedIds.length === 0) return []
  if (!inventory) return [...configuredModels.values()]

  const selected = selectedCatalogModels(selectedIds, inventory)
  return selected.models.map((model) => createModel(model))
}

function logSelection(log: (event: LogEvent) => void, source: Source | undefined, inventory: Inventory | undefined, endpoint: string): void {
  const selectedIds = configuredModelIds(source?.models)
  if (selectedIds.length === 0) {
    log({
      service: PLUGIN_ID,
      level: "warn",
      message: "No Surplus models are selected; the provider remains loaded with zero models",
    })
    return
  }
  if (!inventory) return
  const { missing } = selectedCatalogModels(selectedIds, inventory)
  if (missing.length > 0) {
    log({
      service: PLUGIN_ID,
      level: "warn",
      message: "Some selected Surplus models are absent from the last-known-good inventory",
      extra: { endpoint: safeEndpointForLog(endpoint), missing },
    })
  }
}

export const setup: V2Plugin["setup"] = async (ctx: Context) => {
  const { Model, Provider } = await import("@opencode/plugin")
  type ProviderID = Parameters<typeof Provider.Info.empty>[0]
  type ModelID = Parameters<typeof Model.Info.default>[1]
  const providerID = PROVIDER_ID as ProviderID
  const emptyProvider = () => Provider.Info.empty(providerID)
  const runtimeOptions: RuntimeOptions = resolveRuntimeOptions(ctx.options)
  const log = createLogger()
  let source: Source | undefined

  // This probe captures the native providers.surplus model map and endpoint without
  // inventing a second configuration format. It remains active so reload() can
  // capture the original source again before the application transform replays.
  const probe = await ctx.provider.transform((editor) => {
    source = snapshotSource(editor.get(PROVIDER_ID))
  })

  const configuredEndpoint = source?.provider?.settings?.baseURL
  const endpoint = typeof configuredEndpoint === "string" && configuredEndpoint.trim() ? configuredEndpoint : runtimeOptions.endpoint || DEFAULT_ENDPOINT
  const store = new SurplusInventoryStore({
    endpoint,
    cacheDir: runtimeOptions.cacheDir,
    fetcher: runtimeOptions.fetcher,
    now: runtimeOptions.now,
    warn: (message) => log({ service: PLUGIN_ID, level: "warn", message }),
  })
  let inventory = await store.load()
  const needsRefresh = !store.isFresh(inventory, ttlMilliseconds(runtimeOptions))

  const apply = await ctx.provider.transform((editor) => {
    const info = providerInfo(source, store.endpoint, emptyProvider)
    const models = modelList(source, inventory, (model) => {
      const base = Model.Info.default(providerID, model.id as ModelID)
      return Object.assign(base, toV2Model(model, configuredModelValue(source?.models, model.id)))
    })
    if (source) {
      editor.update(PROVIDER_ID, (provider) => {
        Object.assign(provider, info)
      })
      editor.models.set(PROVIDER_ID, models)
    } else {
      editor.add({ info, models })
    }
  })

  logSelection(log, source, inventory, store.endpoint)

  if (needsRefresh) {
    const refresh = async () => {
      const result = await store.refresh()
      if (result.status === "updated") {
        inventory = result.inventory
        log({
          service: PLUGIN_ID,
          level: "info",
          message: "Refreshed the Surplus model inventory",
          extra: { endpoint: safeEndpointForLog(store.endpoint), count: inventory.models.length },
        })
        try {
          await ctx.provider.reload()
        } catch {
          log({
            service: PLUGIN_ID,
            level: "warn",
            message: "Refreshed the Surplus inventory but could not reload the provider registry",
            extra: { reason: "reload-error" },
          })
        }
      } else {
        log({
          service: PLUGIN_ID,
          level: result.status === "failed" ? "warn" : "info",
          message: "Kept the last-known-good Surplus model inventory",
          extra: { status: result.status, ...(result.status === "failed" ? { reason: result.reason } : {}) },
        })
      }
    }

    if (!inventory) {
      await refresh()
    } else {
      void refresh().catch(() => undefined)
    }
  }

  return async () => {
    await probe.dispose()
    await apply.dispose()
  }
}

export const v2: V2Plugin = { id: PLUGIN_ID, setup }
