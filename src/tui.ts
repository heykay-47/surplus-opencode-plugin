import type { Plugin } from "@opencode/plugin/tui"
import {
  DEFAULT_ENDPOINT,
  PLUGIN_ID,
  PROVIDER_ID,
  PROVIDER_NAME,
  SURPLUS_API_KEY_ENV,
  SurplusInventoryStore,
  configuredModelIds,
  resolveRuntimeOptions,
  type CatalogModel,
} from "./core.js"
import { findConfigDocument, parseHeaderObject, writeModelSelection, writeProviderSetup } from "./config.js"
import { filterCatalogModels, modelDescription, toggleModel } from "./picker.js"

type TuiContext = Parameters<Plugin.Definition["setup"]>[0]

// Plugin.define is an identity helper; keeping the identity local avoids
// importing the TUI package's optional Solid runtime before the host loads us.
function define<T extends Plugin.Definition>(plugin: T): T {
  return plugin
}

type TuiOption = {
  title: string
  value: string
  description?: string
  footer?: string
  category?: string
  disabled?: boolean
}

const DONE = "__opencode_surplus_done__"
const CLEAR = "__opencode_surplus_clear__"

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function configuredEndpoint(context: TuiContext): string | undefined {
  try {
    const providers = context.data?.location?.provider?.list?.(context.location)
    const provider = providers?.find((item) => isRecord(item) && item.id === PROVIDER_ID)
    const settings = isRecord(provider) && isRecord(provider.settings) ? provider.settings : undefined
    return typeof settings?.baseURL === "string" && settings.baseURL.trim() ? settings.baseURL : undefined
  } catch {
    return undefined
  }
}

async function currentSelection(context: TuiContext): Promise<string[]> {
  try {
    const models = context.data?.location?.model?.list?.(context.location) || []
    const current = models
      .map((item) => isRecord(item) && item.providerID === PROVIDER_ID && typeof item.id === "string" ? item.id : undefined)
      .filter((id): id is string => id !== undefined)
    if (current.length > 0) return current

    const directory = context.location?.directory || process.cwd()
    const document = await findConfigDocument(directory, process.env.OPENCODE_CONFIG, "v2")
    const configModels = document.config.providers?.surplus?.models
    return configuredModelIds(configModels)
  } catch {
    return []
  }
}

async function loadInventory(context: TuiContext) {
  const runtimeOptions = resolveRuntimeOptions(context.options)
  const store = new SurplusInventoryStore({
    endpoint: configuredEndpoint(context) || runtimeOptions.endpoint || DEFAULT_ENDPOINT,
    cacheDir: runtimeOptions.cacheDir,
  })
  const cached = await store.load()
  const refreshed = await store.refresh()
  if (refreshed.status === "updated") return refreshed.inventory
  return cached
}

async function selectModels(context: TuiContext, models: CatalogModel[], initial: string[]): Promise<string[] | undefined> {
  const available = new Set(models.map((model) => model.id))
  let selected = new Set(initial.filter((id) => available.has(id)))
  let query = ""

  while (true) {
    const filtered = filterCatalogModels(models, query)
    const options: TuiOption[] = [
      {
        title: "Done",
        value: DONE,
        description: `${selected.size} model${selected.size === 1 ? "" : "s"} selected`,
        category: "Actions",
      },
      {
        title: "Clear selection",
        value: CLEAR,
        description: "Expose zero Surplus models",
        category: "Actions",
        disabled: selected.size === 0,
      },
      ...filtered.map((model) => ({
        title: `${selected.has(model.id) ? "✓ " : "  "}${model.name}`,
        value: model.id,
        description: modelDescription(model),
        footer: model.id,
      })),
    ]

    const value = await context.ui.dialog.select({
      title: "Select Surplus models",
      placeholder: "Search by model name or ID",
      options,
    })
    if (value === undefined) return undefined
    if (value === DONE) return [...selected]
    if (value === CLEAR) {
      selected = new Set()
      query = ""
      continue
    }
    selected = toggleModel(selected, value)
    query = ""
  }
}

async function openPicker(context: TuiContext): Promise<void> {
  try {
    const inventory = await loadInventory(context)
    if (!inventory) {
      context.ui.toast.show({ variant: "error", title: "Surplus", message: "Could not load the Surplus model catalog." })
      return
    }

    const selected = await selectModels(context, inventory.models, await currentSelection(context))
    if (selected === undefined) return

    const directory = context.location?.directory || process.cwd()
    const result = await writeModelSelection(directory, selected, "v2")
    context.data?.location?.provider?.invalidate?.(context.location)
    context.data?.location?.model?.invalidate?.(context.location)
    context.ui.toast.show({
      variant: "success",
      title: "Surplus models saved",
      message: `${selected.length} model${selected.length === 1 ? "" : "s"} saved to ${result.file}. Restart OpenCode if the provider list does not update automatically.`,
    })
  } catch (error) {
    context.ui.toast.show({
      variant: "error",
      title: "Surplus model picker",
      message: error instanceof Error ? error.message : "Could not save the Surplus model selection.",
    })
  }
}

function parseSetupObject(text: string, label: string): Record<string, unknown> {
  if (!text.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // JSON parser messages can include credential-bearing input snippets.
    throw new Error(`${label} must be a valid JSON object.`)
  }
  if (!isRecord(parsed)) throw new Error(`${label} must be a JSON object.`)
  return parsed
}

async function openSetup(context: TuiContext): Promise<void> {
  try {
    const directory = context.location?.directory || process.cwd()
    const document = await findConfigDocument(directory, process.env.OPENCODE_CONFIG, "v2")
    const current = isRecord(document.config.providers?.surplus) ? document.config.providers.surplus : {}
    const currentSettings = isRecord(current.settings) ? current.settings : {}
    const currentHeaders = isRecord(current.headers) ? current.headers : {}

    const baseURL = await context.ui.dialog.prompt({
      title: "Surplus endpoint",
      description: "OpenAI-compatible base URL used for the catalog and inference.",
      value: typeof currentSettings.baseURL === "string" ? currentSettings.baseURL : DEFAULT_ENDPOINT,
    })
    if (baseURL === undefined) return

    const headerText = await context.ui.dialog.prompt({
      title: "Surplus request headers",
      description: "Optional JSON object, e.g. {\"X-Team\":\"core\"}. Omitted or empty entries are removed. Do not enter API keys here.",
      value: Object.keys(currentHeaders).length > 0 ? JSON.stringify(currentHeaders) : "",
    })
    if (headerText === undefined) return

    const { baseURL: _baseURL, ...otherSettings } = currentSettings
    const settingsText = await context.ui.dialog.prompt({
      title: "Surplus provider settings",
      description: "Optional JSON object, e.g. {\"timeout\":600000}. Omitted settings are removed. Do not enter API keys here.",
      value: Object.keys(otherSettings).length > 0 ? JSON.stringify(otherSettings) : "",
    })
    if (settingsText === undefined) return

    const settings = parseSetupObject(settingsText, "Provider settings")
    const headers = parseHeaderObject(parseSetupObject(headerText, "Request headers"))
    const result = await writeProviderSetup(directory, { baseURL: baseURL.trim() || undefined, headers, settings, mode: "replace" }, "v2")
    context.data?.location?.provider?.invalidate?.(context.location)
    await context.ui.dialog.alert({
      title: "Surplus provider saved",
      message: `Settings saved to ${result.file}.\n\nNext: run /connect and choose ${PROVIDER_NAME} to store your API key in OpenCode (or export ${SURPLUS_API_KEY_ENV}), then run /surplus-models. Restart OpenCode if the provider does not update.`,
    })
  } catch (error) {
    context.ui.toast.show({
      variant: "error",
      title: "Surplus setup",
      message: error instanceof Error ? error.message : "Could not save the Surplus provider settings.",
    })
  }
}

export const setup = async (context: TuiContext): Promise<void> => {
  context.ui.slot({
    append: "app",
    render: () => {
      context.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: `${PLUGIN_ID}.pick`,
            title: "Select Surplus models",
            description: "Search and select the Surplus models exposed to OpenCode",
            palette: true,
            slash: { name: "surplus-models", aliases: ["surplus"] },
            run: () => {
              void openPicker(context)
            },
          },
          {
            id: `${PLUGIN_ID}.setup`,
            title: "Set up Surplus provider",
            description: "Configure the Surplus endpoint, headers, and provider settings",
            palette: true,
            slash: { name: "surplus-setup" },
            run: () => {
              void openSetup(context)
            },
          },
        ],
      }))
      return null
    },
  })
}

export default define({ id: PLUGIN_ID, setup })
