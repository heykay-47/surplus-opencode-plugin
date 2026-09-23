import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { atomicFileSystem } from "../src/atomic.js"
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

test("picker preserves private config modes and creates new configs as owner-only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-picker-mode-"))
  const previous = process.env.OPENCODE_CONFIG
  const previousUmask = process.umask(0o022)
  const config = path.join(root, "opencode.json")
  try {
    await chmod(root, 0o755)
    await mkdir(path.join(root, ".git"))
    await writeFile(config, JSON.stringify({ auth: { token: "synthetic-config-secret" }, provider: { surplus: { models: {} } } }), { mode: 0o600 })

    await writeModelSelection(root, ["surplus-v1"], "v1")
    assert.equal((await stat(config)).mode & 0o777, 0o600)
    await writeModelSelection(root, ["surplus-v2"], "v2")
    assert.equal((await stat(config)).mode & 0o777, 0o600)
    assert.equal((parseJsonc(await readFile(config, "utf8")) as any).auth.token, "synthetic-config-secret")

    const newConfig = path.join(root, "new-config.json")
    process.env.OPENCODE_CONFIG = newConfig
    await writeModelSelection(root, ["surplus-new"], "v2")
    assert.equal((await stat(newConfig)).mode & 0o777, 0o600)
    assert.deepEqual(Object.keys((parseJsonc(await readFile(newConfig, "utf8")) as any).providers.surplus.models), ["surplus-new"])
  } finally {
    process.umask(previousUmask)
    if (previous === undefined) delete process.env.OPENCODE_CONFIG
    else process.env.OPENCODE_CONFIG = previous
    await rm(root, { recursive: true, force: true })
  }
})

test("picker failures leave the original config intact and remove its temporary file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-picker-failure-"))
  const config = path.join(root, "opencode.json")
  const original = JSON.stringify({ providers: { surplus: { models: { original: {} } } } })
  try {
    await mkdir(path.join(root, ".git"))
    await writeFile(config, original, { mode: 0o600 })
    const failedFileSystem = {
      ...atomicFileSystem,
      rename: async () => {
        throw new Error("fixture rename failure")
      },
    }

    await assert.rejects(writeModelSelection(root, ["replacement"], "v2", failedFileSystem), /fixture rename failure/)
    assert.equal(await readFile(config, "utf8"), original)
    assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("picker temporary creation refuses a pre-planted symlink", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-picker-symlink-"))
  const config = path.join(root, "opencode.json")
  const protectedFile = path.join(root, "protected.txt")
  let plantedLink: string | undefined
  try {
    await mkdir(path.join(root, ".git"))
    await writeFile(config, JSON.stringify({ provider: { surplus: { models: { original: {} } } } }))
    await writeFile(protectedFile, "must remain unchanged")
    const fileSystem = {
      ...atomicFileSystem,
      open: async (file: string, flags: "wx", mode: number) => {
        plantedLink = file
        await symlink(protectedFile, file)
        return atomicFileSystem.open(file, flags, mode)
      },
    }

    await assert.rejects(writeModelSelection(root, ["replacement"], "v1", fileSystem), { code: "EEXIST" })
    assert.equal(await readFile(protectedFile, "utf8"), "must remain unchanged")
    assert.deepEqual(Object.keys((parseJsonc(await readFile(config, "utf8")) as any).provider.surplus.models), ["original"])
  } finally {
    if (plantedLink) await unlink(plantedLink)
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
