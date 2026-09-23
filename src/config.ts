import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { PLUGIN_ID, parseJsonc } from "./core.js"

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

export async function readConfig(): Promise<Record<string, any>> {
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
    const file = path.resolve(process.cwd(), explicit)
    if (await existing(file)) {
      try {
        config = mergeConfig(config, await readConfigFile(file))
      } catch {
        // An unavailable or malformed explicit file is treated like an unavailable source.
      }
    }
  }

  for (const root of await projectRoots()) await mergeRoot(root)
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

async function writeAtomic(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(temporary, content, "utf8")
  await fs.rename(temporary, file)
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

  await writeAtomic(target.file, `${JSON.stringify(target.config, null, 2)}\n`)
  return { file: target.file, flavor, ids: [...ids] }
}
