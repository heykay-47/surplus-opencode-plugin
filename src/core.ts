import { promises as nodeFs } from "node:fs"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"

export const PLUGIN_ID = "opencode-surplus"
export const PROVIDER_ID = "surplus"
export const PROVIDER_NAME = "Surplus Intelligence"
export const DEFAULT_ENDPOINT = "https://api.surplusintelligence.ai/v1"
export const DEFAULT_TTL_MS = 60 * 60 * 1000
export const CACHE_VERSION = 2

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface LogEvent {
  service: typeof PLUGIN_ID
  level: LogLevel
  message: string
  extra?: Record<string, unknown>
}

export type Logger = (event: LogEvent) => void | Promise<void>

export interface CatalogModel {
  id: string
  name: string
  description?: string
  created?: number
  contextLength?: number
  maxOutputTokens?: number
  inputModalities?: string[]
  outputModalities?: string[]
  pricing?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
  }
  supportedParameters?: string[]
  supportedFeatures?: string[]
  provider?: string
}

export interface Inventory {
  version: typeof CACHE_VERSION
  provider: typeof PROVIDER_ID
  endpoint: string
  endpointKey: string
  account: "public"
  fetchedAt: number
  models: CatalogModel[]
}

export interface RuntimeOptions {
  endpoint?: string
  ttlMs?: number
  ttlHours?: number
  cacheDir?: string
  fetcher?: typeof fetch
  now?: () => number
}

export interface FileSystemLike {
  readFile(file: string, encoding: "utf8"): Promise<string>
  writeFile(file: string, data: string, encoding: "utf8"): Promise<void>
  mkdir(directory: string, options: { recursive: true }): Promise<string | undefined>
  rename(from: string, to: string): Promise<void>
}

export interface SurplusStoreOptions {
  endpoint?: string
  cacheDir?: string
  fetcher?: typeof fetch
  fileSystem?: FileSystemLike
  now?: () => number
}

export type CatalogParseResult =
  | { status: "valid"; models: CatalogModel[] }
  | { status: "empty"; models: [] }
  | { status: "invalid"; models: []; invalidEntries: number }

export type RefreshResult =
  | { status: "updated"; inventory: Inventory }
  | { status: "empty"; inventory?: Inventory }
  | { status: "invalid"; inventory?: Inventory }
  | { status: "failed"; inventory?: Inventory; reason: string }

const defaultFileSystem: FileSystemLike = {
  readFile: (file, encoding) => nodeFs.readFile(file, encoding),
  writeFile: (file, data, encoding) => nodeFs.writeFile(file, data, encoding),
  mkdir: (directory, options) => nodeFs.mkdir(directory, options),
  rename: (from, to) => nodeFs.rename(from, to),
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function positiveInteger(value: unknown): number | undefined {
  const number = finiteNumber(value)
  return number !== undefined && Number.isSafeInteger(number) && number > 0 ? number : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const values = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
  return values.length > 0 ? [...new Set(values)] : undefined
}

function price(value: unknown): number | undefined {
  return finiteNumber(value)
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim()
}

export function normalizeEndpoint(value: string): string {
  try {
    const url = new URL(value)
    url.username = ""
    url.password = ""
    url.hash = ""
    url.pathname = url.pathname.replace(/\/+$/, "") || "/"
    const normalized = url.toString()
    return !url.search && url.pathname === "/" ? normalized.slice(0, -1) : normalized
  } catch {
    return "<invalid-endpoint>"
  }
}

function endpointWithoutQuery(value: string): string {
  try {
    const url = new URL(value)
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    url.pathname = url.pathname.replace(/\/+$/, "") || "/"
    const normalized = url.toString()
    return url.pathname === "/" ? normalized.slice(0, -1) : normalized
  } catch {
    return "<invalid-endpoint>"
  }
}

export function endpointCacheKey(value: string): string {
  const normalized = normalizeEndpoint(value)
  try {
    const url = new URL(normalized)
    const queryHash = createHash("sha256").update(url.search).digest("hex").slice(0, 16)
    return `${endpointWithoutQuery(normalized)}#query-${queryHash}`
  } catch {
    return `invalid-${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`
  }
}

function modelsEndpoint(value: string): string {
  try {
    const url = new URL(value)
    url.username = ""
    url.password = ""
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`
    return url.toString()
  } catch {
    return `${normalizeEndpoint(value)}/models`
  }
}

function normalizeModel(value: unknown, fallbackId?: string): CatalogModel | undefined {
  if (!isRecord(value)) return undefined

  const id = firstString(value.id, fallbackId)
  if (!id) return undefined

  const architecture = isRecord(value.architecture) ? value.architecture : undefined
  const topProvider = isRecord(value.top_provider) ? value.top_provider : isRecord(value.topProvider) ? value.topProvider : undefined
  const rawPricing = isRecord(value.pricing) ? value.pricing : undefined
  const pricing = rawPricing
    ? {
        input: price(rawPricing.prompt ?? rawPricing.input),
        output: price(rawPricing.completion ?? rawPricing.output),
        cacheRead: price(rawPricing.input_cache_read ?? rawPricing.cacheRead),
        cacheWrite: price(rawPricing.input_cache_write ?? rawPricing.cacheWrite),
      }
    : undefined

  const model: CatalogModel = {
    id,
    name: firstString(value.name) ?? id,
  }

  const description = firstString(value.description)
  if (description) model.description = description

  const created = finiteNumber(value.created)
  if (created !== undefined) model.created = created

  const contextLength = positiveInteger(value.context_length ?? value.contextLength ?? topProvider?.context_length ?? topProvider?.contextLength)
  if (contextLength !== undefined) model.contextLength = contextLength

  const maxOutputTokens = positiveInteger(value.max_output_tokens ?? value.maxOutputTokens ?? topProvider?.max_completion_tokens ?? topProvider?.maxCompletionTokens)
  if (maxOutputTokens !== undefined) model.maxOutputTokens = maxOutputTokens

  const inputModalities = stringArray(architecture?.input_modalities ?? architecture?.inputModalities ?? value.inputModalities)
  if (inputModalities) model.inputModalities = inputModalities

  const outputModalities = stringArray(architecture?.output_modalities ?? architecture?.outputModalities ?? value.outputModalities)
  if (outputModalities) model.outputModalities = outputModalities

  if (pricing && Object.values(pricing).some((item) => item !== undefined)) model.pricing = pricing

  const supportedParameters = stringArray(value.supported_parameters ?? value.supportedParameters)
  if (supportedParameters) model.supportedParameters = supportedParameters

  const supportedFeatures = stringArray(value.supported_features ?? value.supportedFeatures)
  if (supportedFeatures) model.supportedFeatures = supportedFeatures

  const provider = firstString(value.provider)
  if (provider) model.provider = provider

  return model
}

export function parseCatalogPayload(payload: unknown): CatalogParseResult {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return { status: "invalid", models: [], invalidEntries: 0 }
  }
  if (payload.data.length === 0) return { status: "empty", models: [] }

  const models = new Map<string, CatalogModel>()
  let invalidEntries = 0
  for (const item of payload.data) {
    const model = normalizeModel(item)
    if (!model) {
      invalidEntries += 1
      continue
    }
    models.set(model.id, model)
  }

  if (models.size === 0) return { status: "invalid", models: [], invalidEntries }
  return { status: "valid", models: [...models.values()] }
}

function parseCachePayload(payload: unknown, endpoint: string): Inventory | undefined {
  if (!isRecord(payload) || payload.version !== CACHE_VERSION || payload.provider !== PROVIDER_ID || payload.account !== "public") return undefined
  const expectedEndpoint = endpointWithoutQuery(endpoint)
  const expectedEndpointKey = endpointCacheKey(endpoint)
  if (normalizeEndpoint(String(payload.endpoint ?? "")) !== expectedEndpoint || payload.endpointKey !== expectedEndpointKey || !Array.isArray(payload.models)) return undefined

  const fetchedAt = finiteNumber(payload.fetchedAt)
  if (fetchedAt === undefined) return undefined

  const models = new Map<string, CatalogModel>()
  for (const item of payload.models) {
    const model = normalizeModel(item)
    if (model) models.set(model.id, model)
  }
  if (models.size === 0) return undefined

  return {
    version: CACHE_VERSION,
    provider: PROVIDER_ID,
    endpoint: expectedEndpoint,
    endpointKey: expectedEndpointKey,
    account: "public",
    fetchedAt,
    models: [...models.values()],
  }
}

function parseLegacyPayload(payload: unknown, endpoint: string): Inventory | undefined {
  if (!isRecord(payload)) return undefined
  const models = new Map<string, CatalogModel>()
  for (const [key, value] of Object.entries(payload)) {
    const model = normalizeModel(value, key)
    if (model) models.set(model.id, model)
  }
  if (models.size === 0) return undefined

  return {
    version: CACHE_VERSION,
    provider: PROVIDER_ID,
    endpoint: endpointWithoutQuery(endpoint),
    endpointKey: endpointCacheKey(endpoint),
    account: "public",
    fetchedAt: 0,
    models: [...models.values()],
  }
}

async function readJson(fileSystem: FileSystemLike, file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fileSystem.readFile(file, "utf8"))
  } catch {
    return undefined
  }
}

export function getCacheDir(): string {
  const configured = process.env.XDG_CACHE_HOME
  return path.join(configured || path.join(os.homedir(), ".cache"), "opencode")
}

export function getCanonicalCacheFile(cacheDir = getCacheDir()): string {
  return path.join(cacheDir, "surplus-models.json")
}

export function getLegacyCacheFile(cacheDir = getCacheDir()): string {
  return path.join(cacheDir, "models-surplus.json")
}

async function writeCanonicalCache(fileSystem: FileSystemLike, file: string, inventory: Inventory): Promise<void> {
  await fileSystem.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await fileSystem.writeFile(temporary, `${JSON.stringify(inventory, null, 2)}\n`, "utf8")
  await fileSystem.rename(temporary, file)
}

export class SurplusInventoryStore {
  readonly endpoint: string
  readonly cacheFile: string
  private readonly legacyFile: string
  private readonly fetcher: typeof fetch
  private readonly fileSystem: FileSystemLike
  private readonly now: () => number
  private lastKnownGood: Inventory | undefined

  constructor(options: SurplusStoreOptions = {}) {
    this.endpoint = normalizeEndpoint(options.endpoint || DEFAULT_ENDPOINT)
    const cacheDir = options.cacheDir || getCacheDir()
    this.cacheFile = getCanonicalCacheFile(cacheDir)
    this.legacyFile = getLegacyCacheFile(cacheDir)
    this.fetcher = options.fetcher || fetch
    this.fileSystem = options.fileSystem || defaultFileSystem
    this.now = options.now || Date.now
  }

  async load(): Promise<Inventory | undefined> {
    if (this.lastKnownGood) return this.lastKnownGood

    const canonical = parseCachePayload(await readJson(this.fileSystem, this.cacheFile), this.endpoint)
    if (canonical) {
      this.lastKnownGood = canonical
      return canonical
    }

    const legacy = this.endpoint === normalizeEndpoint(DEFAULT_ENDPOINT)
      ? parseLegacyPayload(await readJson(this.fileSystem, this.legacyFile), this.endpoint)
      : undefined
    if (legacy) {
      this.lastKnownGood = legacy
      try {
        await writeCanonicalCache(this.fileSystem, this.cacheFile, legacy)
      } catch {
        // Legacy import is best effort; the in-memory inventory remains usable.
      }
      return legacy
    }

    return undefined
  }

  isFresh(inventory: Inventory | undefined, ttlMs: number): boolean {
    return inventory !== undefined && inventory.fetchedAt > 0 && this.now() - inventory.fetchedAt < ttlMs
  }

  async refresh(): Promise<RefreshResult> {
    const fallback = this.lastKnownGood || (await this.load())
    const url = modelsEndpoint(this.endpoint)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)

    try {
      const response = await this.fetcher(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "identity",
        },
      })
      if (!response.ok) return { status: "failed", inventory: fallback, reason: `http-${response.status}` }

      const parsed = parseCatalogPayload(await response.json())
      if (parsed.status === "empty") return { status: "empty", inventory: fallback }
      if (parsed.status === "invalid") return { status: "invalid", inventory: fallback }

      const inventory: Inventory = {
        version: CACHE_VERSION,
        provider: PROVIDER_ID,
        endpoint: endpointWithoutQuery(this.endpoint),
        endpointKey: endpointCacheKey(this.endpoint),
        account: "public",
        fetchedAt: this.now(),
        models: parsed.models,
      }
      try {
        await writeCanonicalCache(this.fileSystem, this.cacheFile, inventory)
      } catch {
        // A fresh response is still authoritative for this process if persistence fails.
      }
      this.lastKnownGood = inventory
      return { status: "updated", inventory }
    } catch (error) {
      const reason = error instanceof DOMException && error.name === "AbortError" ? "timeout" : "request-error"
      return { status: "failed", inventory: fallback, reason }
    } finally {
      clearTimeout(timeout)
    }
  }
}

export function resolveRuntimeOptions(value: unknown): RuntimeOptions {
  if (!isRecord(value)) return {}
  const options: RuntimeOptions = {}
  if (typeof value.endpoint === "string" && value.endpoint.trim()) options.endpoint = value.endpoint
  if (typeof value.cacheDir === "string" && value.cacheDir.trim()) options.cacheDir = value.cacheDir
  if (typeof value.ttlMs === "number" && Number.isFinite(value.ttlMs) && value.ttlMs >= 0) options.ttlMs = value.ttlMs
  if (typeof value.ttlHours === "number" && Number.isFinite(value.ttlHours) && value.ttlHours >= 0) options.ttlHours = value.ttlHours
  if (typeof value.fetcher === "function") options.fetcher = value.fetcher as typeof fetch
  if (typeof value.now === "function") options.now = value.now as () => number
  return options
}

export function ttlMilliseconds(options: RuntimeOptions): number {
  if (options.ttlMs !== undefined) return options.ttlMs
  if (options.ttlHours !== undefined) return options.ttlHours * 60 * 60 * 1000
  return DEFAULT_TTL_MS
}

export function configuredModelIds(models: unknown): string[] {
  if (models instanceof Map) return [...models.keys()].filter((id): id is string => typeof id === "string" && id.length > 0)
  if (!isRecord(models)) return []
  return Object.keys(models)
}

export function configuredModelValue(models: unknown, id: string): unknown {
  return models instanceof Map ? models.get(id) : isRecord(models) ? models[id] : undefined
}

export function selectedCatalogModels(selectedIds: string[], inventory: Inventory | undefined): { models: CatalogModel[]; missing: string[] } {
  if (!inventory) return { models: [], missing: [] }
  const byId = new Map(inventory.models.map((model) => [model.id, model]))
  const models: CatalogModel[] = []
  const missing: string[] = []
  for (const id of selectedIds) {
    const model = byId.get(id)
    if (model) models.push(model)
    else missing.push(id)
  }
  return { models, missing }
}

export function toV1Model(model: CatalogModel, configured: unknown): Record<string, unknown> {
  const explicit = isRecord(configured) ? configured : {}
  const output: Record<string, unknown> = {
    id: model.id,
    name: model.name,
  }

  if (model.contextLength || model.maxOutputTokens) {
    output.limit = {
      ...(model.contextLength ? { context: model.contextLength } : {}),
      ...(model.maxOutputTokens ? { output: model.maxOutputTokens } : {}),
    }
  }
  if (model.pricing) {
    output.cost = {
      ...(model.pricing.input !== undefined ? { input: model.pricing.input * 1_000_000 } : {}),
      ...(model.pricing.output !== undefined ? { output: model.pricing.output * 1_000_000 } : {}),
      ...(model.pricing.cacheRead !== undefined ? { cache_read: model.pricing.cacheRead * 1_000_000 } : {}),
      ...(model.pricing.cacheWrite !== undefined ? { cache_write: model.pricing.cacheWrite * 1_000_000 } : {}),
    }
  }
  if (model.supportedFeatures || model.supportedParameters) {
    const features = new Set([...(model.supportedFeatures || []), ...(model.supportedParameters || [])])
    output.capabilities = { tools: features.has("tools") || features.has("tool_choice") }
  }

  return { ...output, ...explicit, id: model.id }
}

function hasTools(model: CatalogModel): boolean {
  const values = new Set([...(model.supportedFeatures || []), ...(model.supportedParameters || [])])
  return values.has("tools") || values.has("tool_choice")
}

export function toV2Model(model: CatalogModel, configured: unknown): Record<string, unknown> {
  const explicit = isRecord(configured) ? configured : {}
  const output: Record<string, unknown> = {
    id: model.id,
    modelID: model.id,
    providerID: PROVIDER_ID,
    name: model.name,
    capabilities: {
      tools: hasTools(model),
      input: model.inputModalities || [],
      output: model.outputModalities || [],
    },
    variants: [],
    time: { released: model.created ? model.created * 1000 : 0 },
    cost: model.pricing
      ? [
          {
            input: (model.pricing.input || 0) * 1_000_000,
            output: (model.pricing.output || 0) * 1_000_000,
            cache: {
              read: (model.pricing.cacheRead || 0) * 1_000_000,
              write: (model.pricing.cacheWrite || 0) * 1_000_000,
            },
          },
        ]
      : [],
    status: "active",
    enabled: true,
    limit: {
      context: model.contextLength || 0,
      output: model.maxOutputTokens || 0,
    },
  }

  return {
    ...output,
    ...explicit,
    id: model.id,
    modelID: model.id,
    providerID: PROVIDER_ID,
    name: typeof explicit.name === "string" && explicit.name.length > 0 ? explicit.name : model.name,
  }
}

export function parseJsonc(text: string): unknown {
  let output = ""
  let inString = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (inString) {
      output += character
      if (character === "\\") output += text[++index] || ""
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      output += character
    } else if (character === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1
      output += "\n"
    } else if (character === "/" && text[index + 1] === "*") {
      index += 2
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1
      index += 1
    } else {
      output += character
    }
  }
  let withoutTrailingCommas = ""
  inString = false
  for (let index = 0; index < output.length; index += 1) {
    const character = output[index]
    if (inString) {
      withoutTrailingCommas += character
      if (character === "\\") withoutTrailingCommas += output[++index] || ""
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      withoutTrailingCommas += character
      continue
    }
    if (character === ",") {
      let next = index + 1
      while (/\s/.test(output[next] || "")) next += 1
      if (output[next] === "}" || output[next] === "]") continue
    }
    withoutTrailingCommas += character
  }
  return JSON.parse(withoutTrailingCommas)
}

export function safeEndpointForLog(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    url.search = ""
    url.hash = ""
    return `${url.origin}${url.pathname.replace(/\/+$/, "") || "/"}`
  } catch {
    return "<invalid-endpoint>"
  }
}
