import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { runCli } from "../src/cli.js"
import { parseHeaderEntries, parseHeaderObject, parseSettingEntries, writeProviderSetup } from "../src/config.js"
import { parseJsonc } from "../src/core.js"
import tui from "../src/tui.js"

async function withConfig(initial: unknown, run: (file: string, root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-setup-"))
  const file = path.join(root, "opencode.json")
  const previousDirectory = process.cwd()
  const isolatedVariables = ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CLI_CONFIG_CONTENT", "XDG_CONFIG_HOME"]
  const previous = isolatedVariables.map((name) => [name, process.env[name]] as const)
  try {
    await mkdir(path.join(root, ".git"))
    if (initial !== undefined) await writeFile(file, JSON.stringify(initial), { mode: 0o600 })
    process.env.OPENCODE_CONFIG = file
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.OPENCODE_CLI_CONFIG_CONTENT
    process.env.XDG_CONFIG_HOME = path.join(root, ".config")
    process.chdir(root)
    await run(file, root)
  } finally {
    process.chdir(previousDirectory)
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(root, { recursive: true, force: true })
  }
}

const read = async (file: string) => parseJsonc(await readFile(file, "utf8")) as any

type SetupPrompt = { title: string; value: string }

async function runSetupDialog(root: string, answers: Array<string | ((prompt: SetupPrompt) => string)>) {
  const prompts: { title: string; value: string }[] = []
  const errors: string[] = []
  const alerts: string[] = []
  let invalidations = 0
  let run: (() => void) | undefined
  let finish!: () => void
  const finished = new Promise<void>((resolve) => { finish = resolve })
  await tui.setup({
    location: { directory: root },
    ui: {
      slot: ({ render }: any) => render(),
      dialog: {
        prompt: async (prompt: SetupPrompt) => {
          const answer = answers[prompts.length]
          prompts.push(prompt)
          assert.notEqual(answer, undefined, "unexpected setup prompt")
          return typeof answer === "function" ? answer(prompt) : answer
        },
        alert: async ({ message }: { message: string }) => {
          alerts.push(message)
          finish()
        },
      },
      toast: { show: ({ message }: { message: string }) => {
        errors.push(message)
        finish()
      } },
    },
    keymap: { layer: (factory: () => any) => {
      run = factory().commands.find((command: any) => command.slash.name === "surplus-setup")?.run
    } },
    data: { location: { provider: { invalidate: () => { invalidations++ } } } },
  } as any)
  assert.ok(run, "setup slash command must be registered")
  run()
  await finished
  return { prompts, errors, alerts, invalidations }
}

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

test("setup refuses nested credentials and unsafe property names without writing", async (t) => {
  const cases = [
    { name: "nested authorization header", settings: { headers: { Authorization: "fixture-not-a-real-key" } }, error: /Authorization must be an \{env:NAME\}/ },
    { name: "nested API key header", settings: { request: { headers: { "x-api-key": "fixture-not-a-real-key" } } }, error: /x-api-key must be an \{env:NAME\}/ },
    { name: "API key inside an array", settings: { retries: [{ options: { apiKey: "fixture-not-a-real-key" } }] }, error: /apiKey must be an \{env:NAME\}/ },
    { name: "nested reserved name", settings: JSON.parse('{"request":{"constructor":{"polluted":true}}}'), error: /Invalid setting name/ },
  ]
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      await withConfig({ providers: { surplus: { models: {} } } }, async (file, root) => {
        const before = await readFile(file, "utf8")
        await assert.rejects(writeProviderSetup(root, { settings: fixture.settings }, "v2"), fixture.error)
        assert.equal(await readFile(file, "utf8"), before)
        assert.equal(({} as any).polluted, undefined)
      })
    })
  }
})

test("setup entry parsers accept JSON values and reject malformed entries", () => {
  assert.deepEqual(parseHeaderEntries(["X-Team: core", "X-Old:"]), { "X-Team": "core", "X-Old": "" })
  assert.deepEqual(parseHeaderEntries(["Content-Type: application/json; charset=utf-8"]), { "Content-Type": "application/json; charset=utf-8" })
  assert.throws(() => parseHeaderEntries(["no separator"]), /Invalid header entry/)
  assert.throws(() => parseHeaderEntries(["__proto__: fixture-not-a-real-key"]), /Invalid header entry/)
  assert.deepEqual(parseHeaderObject({ Cookie: "session=fixture; theme=dark" }), { Cookie: "session=fixture; theme=dark" })
  assert.throws(() => parseHeaderObject([]), /must be a JSON object/)
  assert.throws(() => parseHeaderObject({ "Bad Name": "value" }), /Invalid header name/)
  assert.throws(() => parseHeaderObject({ "X-Number": 123 }), /values must be strings/)
  assert.deepEqual(parseSettingEntries(["timeout=600000", "name=plain", "flags={\"a\":true}"]), { timeout: 600000, name: "plain", flags: { a: true } })
  assert.throws(() => parseSettingEntries(["=x"]), /Invalid setting entry/)
  for (const key of ["__proto__", "constructor", "prototype"]) {
    assert.throws(() => parseSettingEntries([`${key}=fixture-not-a-real-key`]), /Invalid setting entry/)
  }
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

test("fresh CLI setup defaults to V2 with no generation markers", async () => {
  await withConfig(undefined, async (file) => {
    const errors: string[] = []
    const logs: string[] = []
    const code = await runCli(["setup"], { log: (message: string) => logs.push(message), error: (message: string) => errors.push(message) } as any)
    assert.equal(code, 0, errors.join("\n"))
    const config = await read(file)
    assert.ok(config.providers?.surplus, "fresh setup must create providers.surplus")
    assert.equal(config.provider, undefined)
    assert.ok(logs.some((line) => line.includes("/connect")))
  })
})

test("provider setup defaults to V2 for a new config", async () => {
  await withConfig(undefined, async (file, root) => {
    const result = await writeProviderSetup(root, {})
    assert.equal(result.flavor, "v2")
    assert.ok((await read(file)).providers.surplus)
  })
})

test("CLI setup rejects credentials in JSON settings without logging the value", async () => {
  await withConfig({ providers: { surplus: { models: {} } } }, async (file) => {
    const before = await readFile(file, "utf8")
    const errors: string[] = []
    const code = await runCli(["setup", '--setting=headers={"Authorization":"fixture-not-a-real-key"}'], { log: () => undefined, error: (message: string) => errors.push(message) } as any)
    assert.equal(code, 1)
    assert.ok(errors.some((message) => message.includes("Authorization must be an {env:NAME}")))
    assert.equal(errors.some((message) => message.includes("fixture-not-a-real-key")), false)
    assert.equal(await readFile(file, "utf8"), before)
  })
})

test("TUI setup removes settings deleted from the edited JSON", { timeout: 5000 }, async () => {
  const original = {
    model: "surplus/surplus-a",
    providers: {
      surplus: { name: "Mine", env: ["CUSTOM_KEY"], settings: { baseURL: "https://proxy.example/v1", timeout: 5000, maxRetries: 2 }, models: { "surplus-a": { name: "Keep" } } },
      other: { models: { unrelated: {} } },
    },
  }
  await withConfig(original, async (file, root) => {
    const result = await runSetupDialog(root, ["https://proxy.example/v1", "", '{"maxRetries":2}'])
    assert.deepEqual(result.errors, [])
    const config = await read(file)
    assert.deepEqual(config.providers.surplus.settings, { baseURL: "https://proxy.example/v1", maxRetries: 2 })
    assert.deepEqual(config.providers.surplus.models, original.providers.surplus.models)
    assert.deepEqual(config.providers.surplus.env, ["CUSTOM_KEY"])
    assert.equal(config.providers.surplus.name, "Mine")
    assert.deepEqual(config.providers.other, original.providers.other)
    assert.equal(config.model, original.model)
    assert.equal(result.invalidations, 1)
  })
})

test("TUI setup round-trips headers containing semicolons using a JSON object", { timeout: 5000 }, async () => {
  const headers = { Cookie: "session=fixture; theme=dark", "Content-Type": "application/json; charset=utf-8" }
  await withConfig({ providers: { surplus: { headers, models: {} } } }, async (file, root) => {
    const result = await runSetupDialog(root, ["https://proxy.example/v1", (prompt) => prompt.value, "{}"])
    assert.deepEqual(result.errors, [])
    assert.deepEqual(JSON.parse(result.prompts[1].value), headers)
    assert.deepEqual((await read(file)).providers.surplus.headers, headers)
  })
})

test("TUI setup removes headers omitted from the edited JSON", { timeout: 5000 }, async () => {
  await withConfig({ providers: { surplus: { headers: { "X-Old": "1", "X-Keep": "2" }, models: {} } } }, async (file, root) => {
    const result = await runSetupDialog(root, ["https://proxy.example/v1", '{"X-Keep":"2"}', "{}"])
    assert.deepEqual(result.errors, [])
    assert.deepEqual((await read(file)).providers.surplus.headers, { "X-Keep": "2" })
  })
})

test("setup accepts nested env references and can remove a credential header", async (t) => {
  for (const flavor of ["v1", "v2"] as const) {
    await t.test(flavor, async () => {
      const initialProvider = flavor === "v1"
        ? { options: { headers: { Authorization: "{env:CUSTOM_AUTH}", "X-Keep": "yes" } }, models: {} }
        : { headers: { Authorization: "{env:CUSTOM_AUTH}", "X-Keep": "yes" }, models: {} }
      const rootKey = flavor === "v1" ? "provider" : "providers"
      await withConfig({ [rootKey]: { surplus: initialProvider } }, async (file, root) => {
        const settings = { request: { headers: { "x-api-key": "{env:CUSTOM_KEY}" } }, retries: [{ apiKey: "{env:RETRY_KEY}" }] }
        await writeProviderSetup(root, { settings, headers: { Authorization: "" } }, flavor)
        const provider = (await read(file))[rootKey].surplus
        const options = flavor === "v1" ? provider.options : provider.settings
        assert.deepEqual(options.request, settings.request)
        assert.deepEqual(options.retries, settings.retries)
        assert.deepEqual(flavor === "v1" ? options.headers : provider.headers, { "X-Keep": "yes" })
      })
    })
  }
})

test("CLI setup preserves detected V1 and honors explicit version choices", async (t) => {
  const fixtures = [
    { name: "existing V1 provider", initial: { provider: { surplus: { models: {} } } }, version: undefined, expected: "v1" },
    { name: "existing V1 plugin", initial: { plugin: [] }, version: undefined, expected: "v1" },
    { name: "explicit V1 on a fresh config", initial: undefined, version: "v1", expected: "v1" },
    { name: "explicit V1 overrides V2 markers", initial: { plugins: [] }, version: "v1", expected: "v1" },
    { name: "explicit V2 overrides V1 markers", initial: { plugin: [] }, version: "v2", expected: "v2" },
  ]
  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      await withConfig(fixture.initial, async (file) => {
        const args = fixture.version ? ["setup", `--version=${fixture.version}`] : ["setup"]
        const errors: string[] = []
        assert.equal(await runCli(args, { log: () => undefined, error: (message: string) => errors.push(message) } as any), 0, errors.join("\n"))
        const config = await read(file)
        assert.ok((fixture.expected === "v1" ? config.provider : config.providers).surplus)
      })
    })
  }
})

test("CLI setup detects the generation from an isolated global config", async () => {
  await withConfig(undefined, async (file) => {
    const globalRoot = path.join(process.env.XDG_CONFIG_HOME!, "opencode")
    await mkdir(globalRoot, { recursive: true })
    await writeFile(path.join(globalRoot, "opencode.json"), JSON.stringify({ plugin: [] }), { mode: 0o600 })
    const errors: string[] = []
    assert.equal(await runCli(["setup"], { log: () => undefined, error: (message: string) => errors.push(message) } as any), 0, errors.join("\n"))
    const config = await read(file)
    assert.ok(config.provider.surplus)
    assert.equal(config.providers, undefined)
  })
})

test("CLI setup patches only supplied settings and headers", async () => {
  const originalProvider = {
    settings: { baseURL: "https://proxy.example/v1", timeout: 5000, maxRetries: 2 },
    headers: { "X-Keep": "yes", "X-Remove": "old" },
    models: { "surplus-a": { name: "Mine" } },
  }
  await withConfig({ providers: { surplus: originalProvider } }, async (file) => {
    const errors: string[] = []
    const code = await runCli(["setup", "--setting=timeout=1000", "--header=X-New: new", "--header=X-Remove:"], { log: () => undefined, error: (message: string) => errors.push(message) } as any)
    assert.equal(code, 0, errors.join("\n"))
    const provider = (await read(file)).providers.surplus
    assert.deepEqual(provider.settings, { ...originalProvider.settings, timeout: 1000 })
    assert.deepEqual(provider.headers, { "X-Keep": "yes", "X-New": "new" })
    assert.deepEqual(provider.models, originalProvider.models)
  })
})

test("TUI setup clears optional settings, headers, and the endpoint override", { timeout: 5000 }, async () => {
  await withConfig({ providers: { surplus: { settings: { baseURL: "https://proxy.example/v1", timeout: 5000 }, headers: { "X-Old": "1" }, models: { "surplus-a": {} } } } }, async (file, root) => {
    const result = await runSetupDialog(root, ["", "", ""])
    assert.deepEqual(result.errors, [])
    const provider = (await read(file)).providers.surplus
    assert.deepEqual(provider.settings, {})
    assert.equal(provider.headers, undefined)
    assert.deepEqual(provider.models, { "surplus-a": {} })
    assert.equal(result.invalidations, 1)
  })
})

test("TUI setup rejects invalid input without changing config or echoing credentials", { timeout: 5000 }, async (t) => {
  const fixtures = [
    { name: "nested credential", headers: "{}", settings: '{"request":{"headers":{"Authorization":"fixture-not-a-real-key"}}}', error: /Authorization must be an \{env:NAME\}/ },
    { name: "direct credential header", headers: '{"AUTHORIZATION":"fixture-not-a-real-key"}', settings: "{}", error: /AUTHORIZATION must be an \{env:NAME\}/ },
    { name: "malformed settings JSON", headers: "{}", settings: '{"apiKey":"fixture-not-a-real-key",}', error: /Provider settings must be a valid JSON object/ },
    { name: "malformed headers JSON", headers: '{"Authorization":"fixture-not-a-real-key",}', settings: "{}", error: /Request headers must be a valid JSON object/ },
    { name: "non-object settings", headers: "{}", settings: "[]", error: /Provider settings must be a JSON object/ },
    { name: "non-string header", headers: '{"X-Test":123}', settings: "{}", error: /header values must be strings/ },
    { name: "invalid header name", headers: '{"Bad Name":"fixture-not-a-real-key"}', settings: "{}", error: /Invalid header name/ },
    { name: "nested reserved property", headers: "{}", settings: '{"request":{"__proto__":{"polluted":true}}}', error: /Invalid setting name/ },
  ]
  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      await withConfig({ providers: { surplus: { models: { "surplus-a": {} } } } }, async (file, root) => {
        const before = await readFile(file, "utf8")
        const result = await runSetupDialog(root, ["https://proxy.example/v1", fixture.headers, fixture.settings])
        assert.equal(result.errors.length, 1)
        assert.match(result.errors[0], fixture.error)
        assert.equal(result.errors[0].includes("fixture-not-a-real-key"), false)
        assert.deepEqual(result.alerts, [])
        assert.equal(result.invalidations, 0)
        assert.equal(await readFile(file, "utf8"), before)
        assert.equal(({} as any).polluted, undefined)
      })
    })
  }
})
