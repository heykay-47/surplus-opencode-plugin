import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { parseJsonc } from "../src/core.js"
import { inferConfigFlavor, writeModelSelection } from "../src/config.js"
import { filterCatalogModels, modelDescription, modelSelectionMap, toggleModel } from "../src/picker.js"
import tui from "../src/tui.js"

const models = [
  { id: "surplus-a", name: "Alpha Reasoner", description: "Fast text model", contextLength: 64000, pricing: { input: 0.000001, output: 0.000002 } },
  { id: "surplus-b", name: "Beta Vision", inputModalities: ["text", "image"] },
]

test("picker search matches model IDs, names, and multiple terms", () => {
  assert.deepEqual(filterCatalogModels(models, "alpha"), [models[0]])
  assert.deepEqual(filterCatalogModels(models, "surplus b"), [models[1]])
  assert.deepEqual(filterCatalogModels(models, "missing"), [])
  assert.equal(modelDescription(models[0]), "64,000 context · $1.00/M in / $2.00/M out")
})

test("picker selection helpers preserve explicit model metadata", () => {
  const selected = new Set(["surplus-a"])
  const next = toggleModel(selected, "surplus-b")
  assert.deepEqual([...next], ["surplus-a", "surplus-b"])
  assert.deepEqual(modelSelectionMap(["surplus-b"], { "surplus-b": { name: "Custom" }, "surplus-a": {} }), {
    "surplus-b": { name: "Custom" },
  })
})

test("picker writes the selected native V2 model map and supports V1 override", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-picker-"))
  try {
    await mkdir(path.join(root, ".git"))
    await writeFile(path.join(root, "opencode.jsonc"), `{
      // Existing settings remain valid JSONC input.
      "providers": { "surplus": { "models": { "surplus-a": { "name": "Keep" } } } }
    }`)

    const v2 = await writeModelSelection(root, ["surplus-a", "surplus-b"], "v2")
    assert.equal(v2.flavor, "v2")
    const v2Config = parseJsonc(await readFile(path.join(root, "opencode.jsonc"), "utf8")) as any
    assert.deepEqual(v2Config.providers.surplus.models, {
      "surplus-a": { name: "Keep" },
      "surplus-b": {},
    })

    const v1 = await writeModelSelection(root, [], "v1")
    assert.equal(v1.flavor, "v1")
    const v1Config = parseJsonc(await readFile(path.join(root, "opencode.jsonc"), "utf8")) as any
    assert.deepEqual(v1Config.provider.surplus.models, {})
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("picker infers V1 and V2 config generations", () => {
  assert.equal(inferConfigFlavor({ provider: {} }), "v1")
  assert.equal(inferConfigFlavor({ plugin: [] }), "v1")
  assert.equal(inferConfigFlavor({ providers: {} }), "v2")
  assert.equal(inferConfigFlavor({ plugins: [] }), "v2")
  assert.equal(inferConfigFlavor({}, "v1"), "v1")
})

test("picker honors an explicit config target even when it does not exist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-picker-explicit-"))
  const explicit = path.join(root, "custom-opencode.json")
  const previous = process.env.OPENCODE_CONFIG
  try {
    process.env.OPENCODE_CONFIG = explicit
    const result = await writeModelSelection(root, ["surplus-a"], "v2")
    assert.equal(result.file, explicit)
    const config = parseJsonc(await readFile(explicit, "utf8")) as any
    assert.deepEqual(Object.keys(config.providers.surplus.models), ["surplus-a"])
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG
    else process.env.OPENCODE_CONFIG = previous
    await rm(root, { recursive: true, force: true })
  }
})

test("V2 TUI entrypoint exposes the stable picker plugin ID", () => {
  assert.equal(tui.id, "opencode-surplus")
  assert.equal(typeof tui.setup, "function")
})

test("V2 TUI registers a palette and slash command", async () => {
  const layers: any[] = []
  await tui.setup({ keymap: { layer: (factory: () => unknown) => layers.push(factory()) } } as any)
  const command = layers[0].commands[0]
  assert.equal(command.title, "Select Surplus models")
  assert.equal(command.palette, true)
  assert.equal(command.slash.name, "surplus-models")
})
