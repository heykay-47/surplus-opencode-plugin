#!/usr/bin/env node

import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  DEFAULT_ENDPOINT,
  PLUGIN_ID,
  SurplusInventoryStore,
  configuredModelIds,
  parseJsonc,
  type RuntimeOptions,
} from "./core.js"

function defaultConfigDir(): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode")
}

function configDirs(): string[] {
  const dirs = [defaultConfigDir()]
  const configured = process.env.OPENCODE_CONFIG_DIR
  if (configured && !dirs.includes(configured)) dirs.push(configured)
  return dirs
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function mergeConfig(base: Record<string, any>, next: Record<string, any>): Record<string, any> {
  const merged: Record<string, any> = { ...base }
  for (const [key, value] of Object.entries(next)) {
    // A higher-precedence config's model map is an explicit selection contract;
    // an empty map must not accidentally inherit global selections.
    merged[key] =
      key === "models" || !isRecord(merged[key]) || !isRecord(value) ? value : mergeConfig(merged[key], value)
  }
  return merged
}

async function projectRoots(): Promise<string[]> {
  const roots: string[] = []
  let current = path.resolve(process.cwd())
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

async function readConfigFromRoot(root: string): Promise<Record<string, any> | undefined> {
  const files = [
    path.join(root, "opencode.jsonc"),
    path.join(root, "opencode.json"),
    path.join(root, ".opencode", "opencode.jsonc"),
    path.join(root, ".opencode", "opencode.json"),
  ]
  for (const file of files) {
    try {
      return parseJsonc(await fs.readFile(file, "utf8")) as Record<string, any>
    } catch {
      // Try the next supported OpenCode config filename.
    }
  }
  return undefined
}

async function readConfig(): Promise<Record<string, any>> {
  let config: Record<string, any> = {}
  const globalRoots = configDirs()
  const projectConfigRoots = await projectRoots()
  const seen = new Set<string>()
  const mergeRoot = async (root: string) => {
    if (seen.has(root)) return
    seen.add(root)
    const parsed = await readConfigFromRoot(root)
    if (parsed) config = mergeConfig(config, parsed)
  }

  for (const root of globalRoots) await mergeRoot(root)

  const explicit = process.env.OPENCODE_CONFIG
  if (explicit) {
    try {
      const file = path.resolve(process.cwd(), explicit)
      const parsed = parseJsonc(await fs.readFile(file, "utf8")) as Record<string, any>
      config = mergeConfig(config, parsed)
    } catch {
      // An unavailable explicit file is treated like an unavailable config source.
    }
  }

  for (const root of projectConfigRoots) await mergeRoot(root)
  return config
}

function providerConfig(config: Record<string, any>): Record<string, any> {
  return mergeConfig(config.provider?.surplus || {}, config.providers?.surplus || {})
}

function pluginOptions(config: Record<string, any>): Record<string, any> {
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

function runtimeOptions(config: Record<string, any>, args: string[]): RuntimeOptions {
  const provider = providerConfig(config)
  const plugin = pluginOptions(config)
  const endpoint = provider.options?.baseURL || provider.settings?.baseURL || plugin.endpoint || DEFAULT_ENDPOINT
  const cacheFlag = args.find((arg) => arg.startsWith("--cache-dir="))
  const options: RuntimeOptions = {
    ...plugin,
    endpoint,
  }
  if (cacheFlag) options.cacheDir = cacheFlag.slice("--cache-dir=".length)
  return options
}

export async function runCli(args: string[], output = console): Promise<number> {
  const command = args[0]
  if (command !== "list" && command !== "refresh") {
    output.error("Usage: opencode-surplus <list|refresh> [--cache-dir=/path]")
    return 1
  }

  const config = await readConfig()
  const options = runtimeOptions(config, args)
  const store = new SurplusInventoryStore(options)

  if (command === "refresh") {
    const result = await store.refresh()
    if (result.status !== "updated") {
      output.error(`Surplus inventory was not updated (${result.status})`)
      return 1
    }
    output.log(`Refreshed ${result.inventory.models.length} Surplus models.`)
    return 0
  }

  const inventory = await store.load()
  if (!inventory) {
    output.log("No cached Surplus inventory. Run: opencode-surplus refresh")
    return 0
  }

  const selected = new Set(configuredModelIds(providerConfig(config).models))
  output.log("ID\tNAME\tSELECTED")
  for (const model of inventory.models) {
    output.log(`${model.id}\t${model.name}\t${selected.has(model.id) ? "yes" : "no"}`)
  }
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runCli(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exitCode = code
  })
}
