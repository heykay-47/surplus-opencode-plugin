import type { Plugin as V1Plugin, PluginInput } from "@opencode-ai/plugin"
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
  toV1Model,
  type CatalogModel,
  type Inventory,
  type LogEvent,
  type RuntimeOptions,
} from "./core.js"

function createLogger(input: PluginInput) {
  return async (event: LogEvent) => {
    await input.client.app.log({ body: event })
  }
}

function providerOptions(provider: Record<string, any>): Record<string, any> {
  provider.options ??= {}
  return provider.options
}

function ensureProvider(config: Record<string, any>, defaultEndpoint: string): Record<string, any> {
  config.provider ??= {}
  config.provider[PROVIDER_ID] ??= {}
  const provider = config.provider[PROVIDER_ID]
  provider.npm ??= "@ai-sdk/openai-compatible"
  provider.name ??= PROVIDER_NAME
  const options = providerOptions(provider)
  options.baseURL ??= defaultEndpoint
  return provider
}

function modelMap(configuredModels: Record<string, unknown>, inventory: Inventory | undefined): Record<string, unknown> {
  const selectedIds = configuredModelIds(configuredModels)
  if (selectedIds.length === 0) return {}

  const selected = selectedCatalogModels(selectedIds, inventory)
  if (!inventory) {
    return Object.fromEntries(selectedIds.map((id) => [id, { ...(configuredModelValue(configuredModels, id) as Record<string, unknown> || {}), id }]))
  }

  return Object.fromEntries(
    selected.models.map((model: CatalogModel) => [model.id, toV1Model(model, configuredModelValue(configuredModels, model.id))]),
  )
}

async function logSelection(
  log: (event: LogEvent) => Promise<void>,
  selectedIds: string[],
  inventory: Inventory | undefined,
  endpoint: string,
): Promise<void> {
  if (selectedIds.length === 0) {
    await log({
      service: PLUGIN_ID,
      level: "warn",
      message: "No Surplus models are selected; the provider remains loaded with zero models",
    })
    return
  }
  if (!inventory) return

  const { missing } = selectedCatalogModels(selectedIds, inventory)
  if (missing.length > 0) {
    await log({
      service: PLUGIN_ID,
      level: "warn",
      message: "Some selected Surplus models are absent from the last-known-good inventory",
      extra: { endpoint: safeEndpointForLog(endpoint), missing },
    })
  }
}

async function configure(config: Record<string, any>, runtimeOptions: RuntimeOptions, log: (event: LogEvent) => Promise<void>): Promise<void> {
  const provider = ensureProvider(config, runtimeOptions.endpoint || DEFAULT_ENDPOINT)
  const options = providerOptions(provider)
  const endpoint = typeof options.baseURL === "string" && options.baseURL.trim() ? options.baseURL : runtimeOptions.endpoint || DEFAULT_ENDPOINT
  const store = new SurplusInventoryStore({ endpoint, cacheDir: runtimeOptions.cacheDir, fetcher: runtimeOptions.fetcher, now: runtimeOptions.now })
  const configuredModels = provider.models && typeof provider.models === "object" ? provider.models : {}
  const selectedIds = configuredModelIds(configuredModels)
  let inventory = await store.load()
  const needsRefresh = !store.isFresh(inventory, ttlMilliseconds(runtimeOptions))

  provider.models = modelMap(configuredModels, inventory)
  await logSelection(log, selectedIds, inventory, store.endpoint)

  if (!needsRefresh) return

  const refresh = async () => {
    const result = await store.refresh()
    if (result.status === "updated") {
      inventory = result.inventory
      provider.models = modelMap(configuredModels, inventory)
      await log({
        service: PLUGIN_ID,
        level: "info",
        message: "Refreshed the Surplus model inventory",
        extra: { endpoint: safeEndpointForLog(store.endpoint), count: inventory.models.length },
      })
      await logSelection(log, selectedIds, inventory, store.endpoint)
    } else {
      await log({
        service: PLUGIN_ID,
        level: result.status === "failed" ? "warn" : "info",
        message: "Kept the last-known-good Surplus model inventory",
        extra: { status: result.status, ...(result.status === "failed" ? { reason: result.reason } : {}) },
      })
    }
  }

  if (!inventory) await refresh()
  else void refresh().catch(() => undefined)
}

export const server: V1Plugin = async (input, options) => {
  const runtimeOptions = resolveRuntimeOptions(options)
  const log = createLogger(input)
  return {
    config: async (config) => configure(config as Record<string, any>, runtimeOptions, log),
  }
}
