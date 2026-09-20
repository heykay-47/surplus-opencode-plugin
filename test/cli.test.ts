import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { runCli } from "../src/cli.js"
import { DEFAULT_ENDPOINT, SurplusInventoryStore } from "../src/core.js"

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
