import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { runCli } from "../src/cli.js"
import { parseHeaderEntries, parseSettingEntries, writeProviderSetup } from "../src/config.js"
import { parseJsonc } from "../src/core.js"

async function withConfig(initial: unknown, run: (file: string, root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-setup-"))
  const file = path.join(root, "opencode.json")
  const previous = process.env.OPENCODE_CONFIG
  try {
    if (initial !== undefined) await writeFile(file, JSON.stringify(initial), { mode: 0o600 })
    process.env.OPENCODE_CONFIG = file
    await run(file, root)
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG
    else process.env.OPENCODE_CONFIG = previous
    await rm(root, { recursive: true, force: true })
  }
}

const read = async (file: string) => parseJsonc(await readFile(file, "utf8")) as any

test("V2 setup writes settings, headers, and env credential source while keeping the model selection", async () => {
  await withConfig({ providers: { surplus: { headers: { "X-Old": "1" }, models: { "surplus-a": { name: "Mine" } } } }, model: "surplus/surplus-a" }, async (file, root) => {
    const result = await writeProviderSetup(root, {
      baseURL: "https://proxy.example/v1",
      headers: { "X-Team": "core", "X-Old": "" },
      settings: { timeout: 600000, apiKey: "{env:SURPLUS_API_KEY}" },
    }, "v2")

    const config = await read(file)
    assert.equal(result.flavor, "v2")
    assert.equal(config.model, "surplus/surplus-a")
    assert.deepEqual(config.providers.surplus.env, ["SURPLUS_API_KEY"])
    assert.deepEqual(config.providers.surplus.settings, { timeout: 600000, apiKey: "{env:SURPLUS_API_KEY}", baseURL: "https://proxy.example/v1" })
    assert.deepEqual(config.providers.surplus.headers, { "X-Team": "core" })
    assert.deepEqual(config.providers.surplus.models, { "surplus-a": { name: "Mine" } })
    assert.equal((await stat(file)).mode & 0o777, 0o600)
  })
})

test("V1 setup writes AI SDK options with an env-referenced API key", async () => {
  await withConfig({ provider: { surplus: { models: {} } } }, async (file, root) => {
    await writeProviderSetup(root, { headers: { "X-Team": "core" }, settings: { timeout: 1000 } }, "v1")
    const provider = (await read(file)).provider.surplus
    assert.deepEqual(provider.env, ["SURPLUS_API_KEY"])
    assert.equal(provider.options.apiKey, "{env:SURPLUS_API_KEY}")
    assert.equal(provider.options.timeout, 1000)
    assert.deepEqual(provider.options.headers, { "X-Team": "core" })
  })
})

test("setup refuses literal credentials and leaves the config unchanged", async () => {
  const original = { providers: { surplus: { models: {} } } }
  await withConfig(original, async (file, root) => {
    const before = await readFile(file, "utf8")
    await assert.rejects(writeProviderSetup(root, { settings: { apiKey: "sk-literal-secret" } }, "v2"), /apiKey must be an \{env:NAME\}/)
    await assert.rejects(writeProviderSetup(root, { headers: { Authorization: "Bearer sk-literal-secret" } }, "v2"), /Authorization must be an \{env:NAME\}/)
    await assert.rejects(writeProviderSetup(root, { settings: JSON.parse('{"__proto__": {"polluted": true}}') }, "v2"), /Invalid setting name/)
    assert.equal(await readFile(file, "utf8"), before)
    assert.equal(({} as any).polluted, undefined)
  })
})

test("setup entry parsers accept JSON values and reject malformed entries", () => {
  assert.deepEqual(parseHeaderEntries(["X-Team: core", "X-Old:"]), { "X-Team": "core", "X-Old": "" })
  assert.throws(() => parseHeaderEntries(["no separator"]), /Invalid header entry/)
  assert.deepEqual(parseSettingEntries(["timeout=600000", "name=plain", "flags={\"a\":true}"]), { timeout: 600000, name: "plain", flags: { a: true } })
  assert.throws(() => parseSettingEntries(["=x"]), /Invalid setting entry/)
})

test("CLI setup saves flags and tells the user how to connect a key", async () => {
  await withConfig({ providers: { surplus: { models: {} } } }, async (file) => {
    const logs: string[] = []
    const errors: string[] = []
    const code = await runCli(
      ["setup", "--base-url=https://proxy.example/v1", "--header=X-Team: core", "--setting=timeout=5000"],
      { log: (message: string) => logs.push(message), error: (message: string) => errors.push(message) } as any,
    )
    assert.equal(code, 0, errors.join("\n"))
    const provider = (await read(file)).providers.surplus
    assert.equal(provider.settings.baseURL, "https://proxy.example/v1")
    assert.equal(provider.settings.timeout, 5000)
    assert.deepEqual(provider.headers, { "X-Team": "core" })
    assert.ok(logs.some((line) => line.includes("/connect") && line.includes("SURPLUS_API_KEY")))

    const rejected = await runCli(["setup", "--setting=apiKey=sk-literal-secret"], { log: () => undefined, error: (message: string) => errors.push(message) } as any)
    assert.equal(rejected, 1)
    assert.equal(errors.some((line) => line.includes("sk-literal-secret")), false)
  })
})
