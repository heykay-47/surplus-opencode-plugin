#!/usr/bin/env node

import { createInterface } from "node:readline/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  DEFAULT_ENDPOINT,
  PLUGIN_ID,
  SurplusInventoryStore,
  configuredModelIds,
  type RuntimeOptions,
} from "./core.js"
import {
  inferConfigFlavor,
  pluginOptions,
  providerConfig,
  readConfig,
  writeModelSelection,
} from "./config.js"
import { filterCatalogModels, modelDescription } from "./picker.js"

const terminalControls = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu
const namedTerminalEscapes: Record<number, string> = {
  0x08: "\\b",
  0x09: "\\t",
  0x0a: "\\n",
  0x0c: "\\f",
  0x0d: "\\r",
}

function escapeTerminalText(value: string): string {
  return value.replace(terminalControls, (character) => {
    const codePoint = character.codePointAt(0)!
    if (namedTerminalEscapes[codePoint]) return namedTerminalEscapes[codePoint]
    return codePoint <= 0xff
      ? `\\x${codePoint.toString(16).padStart(2, "0")}`
      : `\\u${codePoint.toString(16).padStart(4, "0")}`
  })
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
  if (command !== "list" && command !== "refresh" && command !== "pick") {
    output.error("Usage: opencode-surplus <list|refresh|pick> [--cache-dir=/path] [--version=v1|v2]")
    return 1
  }

  const config = await readConfig()
  const options = runtimeOptions(config, args)
  const store = new SurplusInventoryStore({ ...options, warn: (message) => output.error(message) })

  if (command === "refresh") {
    const result = await store.refresh()
    if (result.status !== "updated") {
      output.error(`Surplus inventory was not updated (${result.status})`)
      return 1
    }
    output.log(`Refreshed ${result.inventory.models.length} Surplus models.`)
    return 0
  }

  if (command === "pick") {
    const requestedVersion = args.find((arg) => arg.startsWith("--version="))?.slice("--version=".length)
    if (requestedVersion && requestedVersion !== "v1" && requestedVersion !== "v2") {
      output.error("--version must be v1 or v2")
      return 1
    }
    const cached = await store.load()
    const refreshed = await store.refresh()
    const inventory = refreshed.status === "updated" ? refreshed.inventory : cached
    if (!inventory) {
      output.error("Could not load the Surplus model catalog.")
      return 1
    }

    const initial = configuredModelIds(providerConfig(config).models)
    const selected = await interactiveSelection(inventory.models, initial, output)
    if (selected === undefined) {
      output.log("Selection cancelled.")
      return 0
    }

    const result = await writeModelSelection(process.cwd(), selected, inferConfigFlavor(config, requestedVersion))
    output.log(`Saved ${selected.length} Surplus model${selected.length === 1 ? "" : "s"} to ${result.file}.`)
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
    output.log(`${escapeTerminalText(model.id)}\t${escapeTerminalText(model.name)}\t${selected.has(model.id) ? "yes" : "no"}`)
  }
  return 0
}

async function interactiveSelection(
  models: import("./core.js").CatalogModel[],
  initial: string[],
  output: Pick<Console, "log">,
): Promise<string[] | undefined> {
  const input = createInterface({ input: process.stdin, output: process.stdout })
  const available = new Set(models.map((model) => model.id))
  const selected = new Set(initial.filter((id) => available.has(id)))
  try {
    while (true) {
      const query = await input.question('Search Surplus models (type "q" to cancel): ')
      if (query.trim().toLowerCase() === "q") return undefined
      const matches = filterCatalogModels(models, query).slice(0, 100)
      output.log(matches.length === 0 ? "No matching models." : "")
      matches.forEach((model, index) => {
        output.log(`${index + 1}. ${selected.has(model.id) ? "[x]" : "[ ]"} ${escapeTerminalText(model.name)} — ${escapeTerminalText(model.id)} (${escapeTerminalText(modelDescription(model))})`)
      })
      const answer = await input.question('Toggle numbers or IDs (comma-separated), "clear", or "done": ')
      const normalized = answer.trim().toLowerCase()
      if (normalized === "done") return [...selected]
      if (normalized === "clear") {
        selected.clear()
        continue
      }
      for (const token of answer.split(",").map((item) => item.trim()).filter(Boolean)) {
        const index = Number(token)
        const model = Number.isInteger(index) && index > 0 && index <= matches.length ? matches[index - 1] : models.find((item) => item.id === token)
        if (!model) continue
        if (selected.has(model.id)) selected.delete(model.id)
        else selected.add(model.id)
      }
    }
  } finally {
    input.close()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runCli(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exitCode = code
  })
}
