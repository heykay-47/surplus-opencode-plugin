import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { atomicFileSystem, writeFileAtomically, type AtomicFileSystem } from "./atomic.js"
import { PLUGIN_ID, SURPLUS_API_KEY_ENV, parseJsonc } from "./core.js"

export type ConfigFlavor = "v1" | "v2"

export interface ConfigDocument {
  file: string
  config: Record<string, any>
  flavor: ConfigFlavor
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function mergeConfig(base: Record<string, any>, next: Record<string, any>): Record<string, any> {
  const merged: Record<string, any> = { ...base }
  for (const [key, value] of Object.entries(next)) {
    // A higher-precedence config's model map is an explicit selection contract;
    // an empty map must not accidentally inherit global selections.
    merged[key] =
      key === "models" || !isRecord(merged[key]) || !isRecord(value) ? value : mergeConfig(merged[key], value)
  }
  return merged
}

function defaultConfigDir(): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode")
}

function configDirs(): string[] {
  const dirs = [defaultConfigDir()]
  const configured = process.env.OPENCODE_CONFIG_DIR
  if (configured && !dirs.includes(configured)) dirs.push(configured)
  return dirs
}

export async function projectRoots(directory = process.cwd()): Promise<string[]> {
  const roots: string[] = []
  let current = path.resolve(directory)
  while (true) {
    roots.unshift(current)
    try {
      await fs.stat(path.join(current, ".git"))
      return roots
    } catch {
      // Continue to the next parent when this is not a repository root.
    }
    const parent = path.dirname(current)
    if (parent === current) return roots
    current = parent
  }
}

const configNames = [
  "opencode.jsonc",
  "opencode.json",
  path.join(".opencode", "opencode.jsonc"),
  path.join(".opencode", "opencode.json"),
]

async function existing(file: string): Promise<boolean> {
  try {
    await fs.stat(file)
    return true
  } catch {
    return false
  }
}

async function readConfigFile(file: string): Promise<Record<string, any>> {
  try {
    const parsed = parseJsonc(await fs.readFile(file, "utf8"))
    return isRecord(parsed) ? parsed : {}
  } catch (error) {
    throw new Error(`Could not parse OpenCode config ${file}`, { cause: error })
  }
}

async function readConfigFromRoot(root: string): Promise<Record<string, any> | undefined> {
  for (const name of configNames) {
    const file = path.join(root, name)
    if (!(await existing(file))) continue
    try {
      return await readConfigFile(file)
    } catch {
      // Preserve the existing CLI behavior: try the next supported config path.
    }
  }
  return undefined
}

export async function readConfig(directory = process.cwd()): Promise<Record<string, any>> {
  let config: Record<string, any> = {}
  const seen = new Set<string>()
  const mergeRoot = async (root: string) => {
    if (seen.has(root)) return
    seen.add(root)
    const parsed = await readConfigFromRoot(root)
    if (parsed) config = mergeConfig(config, parsed)
  }

  for (const root of configDirs()) await mergeRoot(root)

  const explicit = process.env.OPENCODE_CONFIG
  if (explicit) {
    const file = path.resolve(directory, explicit)
    if (await existing(file)) {
      try {
        config = mergeConfig(config, await readConfigFile(file))
      } catch {
        // An unavailable or malformed explicit file is treated like an unavailable source.
      }
    }
  }

  for (const root of await projectRoots(directory)) await mergeRoot(root)
  return config
}

export function providerConfig(config: Record<string, any>): Record<string, any> {
  return mergeConfig(config.provider?.surplus || {}, config.providers?.surplus || {})
}

export function pluginOptions(config: Record<string, any>): Record<string, any> {
  const entries = [
    ...(Array.isArray(config.plugin) ? config.plugin : []),
    ...(Array.isArray(config.plugins) ? config.plugins : []),
  ]
  for (const entry of entries) {
    const packageName = typeof entry === "string" ? entry : Array.isArray(entry) ? entry[0] : entry?.package
    if (packageName !== PLUGIN_ID) continue
    const options = Array.isArray(entry) ? entry[1] : entry?.options
    return options && typeof options === "object" ? options : {}
  }
  return {}
}

export function inferConfigFlavor(config: Record<string, any>, requested?: string): ConfigFlavor {
  if (requested === "v1" || requested === "v2") return requested
  if (config.providers !== undefined || config.plugins !== undefined) return "v2"
  return "v1"
}

async function findExistingProjectConfig(directory: string): Promise<{ file: string; config: Record<string, any> } | undefined> {
  const roots = await projectRoots(directory)
  for (const root of [...roots].reverse()) {
    for (const name of configNames) {
      const file = path.join(root, name)
      if (await existing(file)) {
        try {
          return { file, config: await readConfigFile(file) }
        } catch {
          // A malformed higher-precedence file must not be overwritten. Continue
          // looking for a usable project config instead.
        }
      }
    }
  }
  return undefined
}

export async function findConfigDocument(
  directory = process.cwd(),
  explicitFile?: string,
  requestedFlavor?: string,
): Promise<ConfigDocument> {
  if (explicitFile) {
    const file = path.isAbsolute(explicitFile) ? explicitFile : path.resolve(process.cwd(), explicitFile)
    if (await existing(file)) {
      const config = await readConfigFile(file)
      return { file, config, flavor: inferConfigFlavor(config, requestedFlavor) }
    }
    return {
      file,
      config: {},
      flavor: inferConfigFlavor({}, requestedFlavor),
    }
  }

  const project = await findExistingProjectConfig(directory)
  if (project) return { ...project, flavor: inferConfigFlavor(project.config, requestedFlavor) }

  const config: Record<string, any> = {}
  return {
    file: path.join(path.resolve(directory), "opencode.json"),
    config,
    flavor: inferConfigFlavor(config, requestedFlavor),
  }
}

export interface ProviderSetup {
  baseURL?: string
  headers?: Record<string, string>
  settings?: Record<string, unknown>
}

export interface ProviderSetupWriteResult {
  file: string
  flavor: ConfigFlavor
}

const envReference = /^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/
const credentialHeaders = new Set(["authorization", "proxy-authorization", "x-api-key", "api-key"])

// Setup writes provider options only. A credential may appear solely as an
// `{env:NAME}` reference so the literal key stays in OpenCode's credential
// store or the environment, never in a config file that may be committed.
export function assertNoLiteralCredentials(setup: ProviderSetup): void {
  for (const key of Object.keys(setup.settings ?? {})) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") throw new Error(`Invalid setting name: ${key}`)
  }
  const apiKey = setup.settings?.apiKey
  if (apiKey !== undefined && (typeof apiKey !== "string" || !envReference.test(apiKey))) {
    throw new Error("settings.apiKey must be an {env:NAME} reference; connect the key with /connect or SURPLUS_API_KEY instead")
  }
  for (const [name, value] of Object.entries(setup.headers ?? {})) {
    if (credentialHeaders.has(name.toLowerCase()) && !envReference.test(value)) {
      throw new Error(`Header ${name} must be an {env:NAME} reference; connect the key with /connect or SURPLUS_API_KEY instead`)
    }
  }
}

// Parses `Name: value` entries. An empty value removes a previously set header.
export function parseHeaderEntries(entries: string[]): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const entry of entries) {
    const separator = entry.indexOf(":")
    const name = separator > 0 ? entry.slice(0, separator).trim() : ""
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error(`Invalid header entry: ${entry}`)
    headers[name] = entry.slice(separator + 1).trim()
  }
  return headers
}

// Parses `key=value` entries; values are JSON when they parse as JSON.
export function parseSettingEntries(entries: string[]): Record<string, unknown> {
  const settings: Record<string, unknown> = {}
  for (const entry of entries) {
    const separator = entry.indexOf("=")
    const key = separator > 0 ? entry.slice(0, separator).trim() : ""
    if (!key || key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error(`Invalid setting entry: ${entry}`)
    }
    const raw = entry.slice(separator + 1).trim()
    try {
      settings[key] = JSON.parse(raw)
    } catch {
      settings[key] = raw
    }
  }
  return settings
}

function mergeHeaders(existing: unknown, updates: Record<string, string> | undefined): Record<string, string> | undefined {
  const merged: Record<string, string> = isRecord(existing) ? { ...existing } : {}
  for (const [name, value] of Object.entries(updates ?? {})) {
    if (value === "") delete merged[name]
    else merged[name] = value
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

export async function writeProviderSetup(
  directory: string,
  setup: ProviderSetup,
  requestedFlavor?: string,
  fileSystem: AtomicFileSystem = atomicFileSystem,
): Promise<ProviderSetupWriteResult> {
  assertNoLiteralCredentials(setup)
  const target = await findConfigDocument(directory, process.env.OPENCODE_CONFIG, requestedFlavor)
  const flavor = inferConfigFlavor(target.config, requestedFlavor)
  const rootKey = flavor === "v1" ? "provider" : "providers"
  const root = isRecord(target.config[rootKey]) ? target.config[rootKey] : {}
  const provider = isRecord(root.surplus) ? root.surplus : {}
  provider.env ??= [SURPLUS_API_KEY_ENV]

  if (flavor === "v1") {
    // V1 passes provider options, including headers, to the AI SDK package.
    const options = isRecord(provider.options) ? provider.options : {}
    Object.assign(options, setup.settings)
    if (setup.baseURL) options.baseURL = setup.baseURL
    options.apiKey ??= `{env:${SURPLUS_API_KEY_ENV}}`
    const headers = mergeHeaders(options.headers, setup.headers)
    if (headers) options.headers = headers
    else delete options.headers
    provider.options = options
  } else {
    const settings = isRecord(provider.settings) ? provider.settings : {}
    Object.assign(settings, setup.settings)
    if (setup.baseURL) settings.baseURL = setup.baseURL
    provider.settings = settings
    const headers = mergeHeaders(provider.headers, setup.headers)
    if (headers) provider.headers = headers
    else delete provider.headers
  }
  provider.models ??= {}
  root.surplus = provider
  target.config[rootKey] = root

  await writeFileAtomically(target.file, `${JSON.stringify(target.config, null, 2)}\n`, fileSystem)
  return { file: target.file, flavor }
}

export interface ModelSelectionWriteResult {
  file: string
  flavor: ConfigFlavor
  ids: string[]
}

export async function writeModelSelection(
  directory: string,
  ids: string[],
  requestedFlavor?: string,
  fileSystem: AtomicFileSystem = atomicFileSystem,
): Promise<ModelSelectionWriteResult> {
  const target = await findConfigDocument(directory, process.env.OPENCODE_CONFIG, requestedFlavor)
  const flavor = inferConfigFlavor(target.config, requestedFlavor)
  const rootKey = flavor === "v1" ? "provider" : "providers"
  const root = isRecord(target.config[rootKey]) ? target.config[rootKey] : {}
  const provider = isRecord(root.surplus) ? root.surplus : {}
  const existingModels = isRecord(provider.models) ? provider.models : {}
  provider.models = Object.fromEntries(
    ids.map((id) => [id, isRecord(existingModels[id]) ? existingModels[id] : {}]),
  )
  root.surplus = provider
  target.config[rootKey] = root

  await writeFileAtomically(target.file, `${JSON.stringify(target.config, null, 2)}\n`, fileSystem)
  return { file: target.file, flavor, ids: [...ids] }
}
