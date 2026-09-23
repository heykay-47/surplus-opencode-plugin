import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { runCli } from "../src/cli.js"
import { DEFAULT_ENDPOINT, SurplusInventoryStore, parseJsonc } from "../src/core.js"

test("CLI applies global, explicit, and project config precedence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-cli-"))
  const xdg = path.join(root, "xdg")
  const custom = path.join(root, "custom")
  const project = path.join(root, "project")
  const cacheDir = path.join(root, "cache")
  const explicit = path.join(root, "explicit.json")
  await Promise.all([
    mkdir(path.join(xdg, "opencode"), { recursive: true }),
    mkdir(custom, { recursive: true }),
    mkdir(path.join(project, ".git"), { recursive: true }),
  ])

  await writeFile(path.join(xdg, "opencode", "opencode.json"), JSON.stringify({
    providers: { surplus: { models: { "surplus-global": {} } } },
  }))
  await writeFile(path.join(custom, "opencode.json"), JSON.stringify({
    providers: { surplus: { models: { "surplus-custom": {} } } },
  }))
  await writeFile(explicit, JSON.stringify({
    providers: { surplus: { models: { "surplus-explicit": {} } } },
  }))
  await writeFile(path.join(project, "opencode.json"), JSON.stringify({
    providers: { surplus: { models: { "surplus-project": {} } } },
  }))

  const store = new SurplusInventoryStore({
    cacheDir,
    fetcher: async () => new Response(JSON.stringify({
      data: [
        { id: "surplus-global", name: "global" },
        { id: "surplus-custom", name: "custom" },
        { id: "surplus-explicit", name: "explicit" },
        { id: "surplus-project", name: "project" },
      ],
    }), { status: 200 }),
  })
  await store.refresh()

  const previous = {
    cwd: process.cwd(),
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    OPENCODE_CONFIG: process.env.OPENCODE_CONFIG,
  }
  const logs: string[] = []
  try {
    process.chdir(project)
    process.env.XDG_CONFIG_HOME = xdg
    process.env.OPENCODE_CONFIG_DIR = custom
    process.env.OPENCODE_CONFIG = explicit
    const output = {
      log: (message: unknown) => logs.push(String(message)),
      error: (message: unknown) => logs.push(`ERROR: ${String(message)}`),
    } as unknown as Console
    assert.equal(await runCli(["list", `--cache-dir=${cacheDir}`], output), 0)
  } finally {
    process.chdir(previous.cwd)
    for (const [key, value] of Object.entries(previous)) {
      if (key === "cwd") continue
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }

  assert.ok(logs.some((line) => line.includes("surplus-global\tglobal\tno")))
  assert.ok(logs.some((line) => line.includes("surplus-custom\tcustom\tno")))
  assert.ok(logs.some((line) => line.includes("surplus-explicit\texplicit\tno")))
  assert.ok(logs.some((line) => line.includes("surplus-project\tproject\tyes")))
  assert.equal(logs.some((line) => line.includes(DEFAULT_ENDPOINT)), false)
})

test("CLI list escapes catalog terminal controls without changing its row separators", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-cli-controls-"))
  const previous = {
    cwd: process.cwd(),
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    OPENCODE_CONFIG: process.env.OPENCODE_CONFIG,
  }
  const cacheDir = path.join(root, "cache")
  const unsafeId = "model-\u001b[31mred\r\n\t\u202e"
  const unsafeName = "name-\u009b2J\r\n\t\u2066"
  const store = new SurplusInventoryStore({
    cacheDir,
    fetcher: async () => new Response(JSON.stringify({ data: [{ id: unsafeId, name: unsafeName }] }), { status: 200 }),
  })
  const logs: string[] = []
  try {
    await mkdir(path.join(root, ".git"))
    await store.refresh()
    process.chdir(root)
    process.env.XDG_CONFIG_HOME = path.join(root, "xdg")
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.OPENCODE_CONFIG
    const output = {
      log: (message: unknown) => logs.push(String(message)),
      error: (message: unknown) => logs.push(`ERROR: ${String(message)}`),
    } as unknown as Console

    assert.equal(await runCli(["list", `--cache-dir=${cacheDir}`], output), 0)
  } finally {
    process.chdir(previous.cwd)
    for (const [key, value] of Object.entries(previous)) {
      if (key === "cwd") continue
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }

  const dataRow = logs.find((line) => line.startsWith("model-"))
  assert.ok(dataRow)
  assert.equal(dataRow.split("\t").length, 3)
  assert.ok(dataRow.includes("model-\\x1b[31mred\\r\\n\\t\\u202e"))
  assert.ok(dataRow.includes("name-\\x9b2J\\r\\n\\t\\u2066"))
  assert.equal(logs.join("\n").includes("\u001b"), false)
  assert.equal(logs.join("\n").includes("\u009b"), false)
  assert.equal(logs.join("\n").includes("\u202e"), false)
  assert.equal(logs.join("\n").includes("\u2066"), false)
})

test("CLI pick displays hostile fields safely and persists the selected ID unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-cli-pick-controls-"))
  const cacheDir = path.join(root, "cache")
  const projectConfig = path.join(root, "opencode.json")
  const unsafeId = "model-\u001b[31mred\r\n\t\u202e"
  const unsafeName = "name-\u009b2J\r\n\t\u2066"
  const unsafeProvider = "provider-\u001b]0;hostile\u0007"
  const prompts = ["", "1", "", "done"]
  const logs: string[] = []
  let requestedPath = ""
  const server = createServer((request, response) => {
    requestedPath = request.url || ""
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ data: [{ id: unsafeId, name: unsafeName, provider: unsafeProvider }] }))
  })
  const previous = {
    cwd: process.cwd(),
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    OPENCODE_CONFIG: process.env.OPENCODE_CONFIG,
  }

  try {
    await mkdir(path.join(root, ".git"))
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => resolve())
    })
    const address = server.address()
    assert.ok(address && typeof address !== "string")
    const endpoint = `http://127.0.0.1:${address.port}/private-path?token=query-secret`
    await writeFile(projectConfig, JSON.stringify({ providers: { surplus: { settings: { baseURL: endpoint }, models: {} } } }))
    process.chdir(root)
    process.env.XDG_CONFIG_HOME = path.join(root, "xdg")
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.OPENCODE_CONFIG
    const output = {
      log: (message: unknown) => logs.push(String(message)),
      error: (message: unknown) => logs.push(`ERROR: ${String(message)}`),
    } as unknown as Console
    const prompt = async () => prompts.shift() ?? "q"

    assert.equal(await runCli(["pick", "--version=v2", `--cache-dir=${cacheDir}`], output, prompt), 0)

    assert.equal(requestedPath, "/private-path/models?token=query-secret")
    const saved = parseJsonc(await readFile(projectConfig, "utf8")) as any
    const selectedId = Object.keys(saved.providers.surplus.models)[0]
    assert.equal(selectedId, unsafeId)
    assert.deepEqual(Buffer.from(selectedId), Buffer.from(unsafeId))
    assert.ok(logs.some((line) => line.includes("model-\\x1b[31mred\\r\\n\\t\\u202e")))
    assert.ok(logs.some((line) => line.includes("name-\\x9b2J\\r\\n\\t\\u2066")))
    assert.ok(logs.some((line) => line.includes("provider-\\x1b]0;hostile\\x07")))
    assert.equal(logs.join("\n").includes("\u001b"), false)
    assert.equal(logs.join("\n").includes("\u009b"), false)
    assert.equal(logs.join("\n").includes("\u202e"), false)
    assert.equal(logs.join("\n").includes("\u2066"), false)
    assert.equal(logs.join("\n").includes("private-path"), false)
    assert.equal(logs.join("\n").includes("query-secret"), false)
    const persistedCache = await readFile(path.join(cacheDir, "surplus-models.json"), "utf8")
    assert.equal(persistedCache.includes("private-path"), false)
    assert.equal(persistedCache.includes("query-secret"), false)
  } finally {
    process.chdir(previous.cwd)
    for (const [key, value] of Object.entries(previous)) {
      if (key === "cwd") continue
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
