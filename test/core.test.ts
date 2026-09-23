import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { atomicFileSystem } from "../src/atomic.js"
import {
  DEFAULT_ENDPOINT,
  SurplusInventoryStore,
  endpointCacheKey,
  normalizeEndpoint,
  parseCatalogPayload,
  parseJsonc,
  safeEndpointForLog,
  selectedCatalogModels,
  toV1Model,
  toV2Model,
} from "../src/core.js"

test("catalog parsing filters malformed entries and preserves rich metadata", () => {
  const result = parseCatalogPayload({
    data: [
      {
        id: "surplus-a",
        description: "A useful model",
        context_length: 128000,
        top_provider: { max_completion_tokens: 4096 },
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        pricing: { prompt: "0.00000007", completion: "0.00000028" },
        supported_features: ["tools"],
      },
      { id: "surplus-b" },
      { id: "" },
      "not a model",
    ],
  })

  assert.equal(result.status, "valid")
  if (result.status !== "valid") return
  assert.deepEqual(result.models[0], {
    id: "surplus-a",
    name: "surplus-a",
    description: "A useful model",
    contextLength: 128000,
    maxOutputTokens: 4096,
    inputModalities: ["text"],
    outputModalities: ["text"],
    pricing: { input: 0.00000007, output: 0.00000028, cacheRead: undefined, cacheWrite: undefined },
    supportedFeatures: ["tools"],
  })
  assert.equal(result.models[1].name, "surplus-b")
})

test("empty and all-malformed catalogs are not authoritative", () => {
  assert.deepEqual(parseCatalogPayload({ data: [] }), { status: "empty", models: [] })
  assert.deepEqual(parseCatalogPayload({ data: [{ name: "missing id" }] }), {
    status: "invalid",
    models: [],
    invalidEntries: 1,
  })
})

test("the cache keeps the last-known-good inventory across empty refreshes", async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-cache-"))
  let response: unknown = { data: [{ id: "surplus-a", name: "A" }] }
  try {
    const first = new SurplusInventoryStore({
      cacheDir,
      fetcher: async () => new Response(JSON.stringify(response), { status: 200 }),
      now: () => 10_000,
    })
    const updated = await first.refresh()
    assert.equal(updated.status, "updated")

    response = { data: [] }
    const second = new SurplusInventoryStore({
      cacheDir,
      fetcher: async () => new Response(JSON.stringify(response), { status: 200 }),
      now: () => 20_000,
    })
    const result = await second.refresh()
    assert.equal(result.status, "empty")
    assert.equal(result.inventory?.models[0].id, "surplus-a")
    assert.match(await readFile(path.join(cacheDir, "surplus-models.json"), "utf8"), /surplus-a/)
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
  }
})

test("selection is an exact allowlist and adapters preserve explicit metadata", () => {
  const inventory = {
    version: 2 as const,
    provider: "surplus" as const,
    endpoint: DEFAULT_ENDPOINT,
    endpointKey: endpointCacheKey(DEFAULT_ENDPOINT),
    account: "public" as const,
    fetchedAt: 1,
    models: [
      { id: "surplus-a", name: "Catalog A", contextLength: 1000 },
      { id: "surplus-b", name: "Catalog B" },
    ],
  }
  const selected = selectedCatalogModels(["surplus-b", "surplus-missing"], inventory)
  assert.deepEqual(selected.models.map((model) => model.id), ["surplus-b"])
  assert.deepEqual(selected.missing, ["surplus-missing"])
  assert.deepEqual(toV1Model(inventory.models[0], { name: "User A", temperature: 0.2 }), {
    id: "surplus-a",
    name: "User A",
    limit: { context: 1000 },
    temperature: 0.2,
  })
  assert.equal((toV2Model(inventory.models[0], { name: "User A" }) as any).name, "User A")
})

test("JSONC config parsing accepts comments and trailing commas", () => {
  assert.deepEqual(parseJsonc('{ // comment\n "providers": { "surplus": { "models": {}, }, }, }'), {
    providers: { surplus: { models: {} } },
  })
  assert.deepEqual(parseJsonc('{ "text": "comma,}" }'), { text: "comma,}" })
})

test("query-based endpoints remain distinct without leaking query secrets", async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-query-"))
  let requested = ""
  try {
    const store = new SurplusInventoryStore({
      endpoint: `${DEFAULT_ENDPOINT}?token=secret-value/`,
      cacheDir,
      fetcher: async (url) => {
        requested = typeof url === "string" ? url : url.toString()
        return new Response(JSON.stringify({ data: [{ id: "surplus-a" }] }), { status: 200 })
      },
      now: () => 1000,
    })
    const result = await store.refresh()
    assert.equal(result.status, "updated")
    assert.equal(requested, `${DEFAULT_ENDPOINT}/models?token=secret-value/`)
    assert.equal(result.inventory?.endpoint, "https://api.surplusintelligence.ai")
    const cache = await readFile(path.join(cacheDir, "surplus-models.json"), "utf8")
    assert.equal(cache.includes("secret-value"), false)
    assert.equal(cache.includes("/v1"), false)
    assert.equal(safeEndpointForLog(`${DEFAULT_ENDPOINT}?token=secret-value/`).includes("secret-value"), false)
    assert.equal(safeEndpointForLog(`${DEFAULT_ENDPOINT}?token=secret-value/`).includes("/v1"), false)
    assert.equal(normalizeEndpoint(`https://user:pass@api.surplusintelligence.ai/v1`), DEFAULT_ENDPOINT)
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
  }
})

test("endpoint identities distinguish paths and queries without persisting or logging them", () => {
  const one = "https://user-a:pass-a@proxy.example/private-path-a?token=path-secret-a#fragment-secret-a"
  const two = "https://user-b:pass-b@proxy.example/private-path-b?token=path-secret-b#fragment-secret-b"
  const firstKey = endpointCacheKey(one)
  const secondKey = endpointCacheKey(two)
  const firstLog = safeEndpointForLog(one)
  const secondLog = safeEndpointForLog(two)

  assert.notEqual(firstKey, secondKey)
  assert.match(firstKey, /^[a-f0-9]{64}$/)
  assert.match(secondKey, /^[a-f0-9]{64}$/)
  assert.notEqual(firstLog, secondLog)
  for (const secret of [
    "user-a", "pass-a", "private-path-a", "path-secret-a", "fragment-secret-a",
    "user-b", "pass-b", "private-path-b", "path-secret-b", "fragment-secret-b",
  ]) {
    assert.equal(firstKey.includes(secret), false)
    assert.equal(secondKey.includes(secret), false)
    assert.equal(firstLog.includes(secret), false)
    assert.equal(secondLog.includes(secret), false)
  }
  assert.equal(firstLog.includes("/private-path-a"), false)
})

test("same-origin custom endpoints with different paths and queries do not reuse cache entries", async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-endpoint-scope-"))
  const requested: string[] = []
  const httpServer = createServer((request, response) => {
    requested.push(request.url || "")
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({
      data: [{ id: request.url?.startsWith("/private-a/") ? "inventory-a" : "inventory-b" }],
    }))
  })

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject)
      httpServer.listen(0, "127.0.0.1", () => resolve())
    })
    const address = httpServer.address()
    assert.ok(address && typeof address !== "string")
    const firstEndpoint = `http://user-a:pass-a@127.0.0.1:${address.port}/private-a?token=query-a#fragment-a`
    const secondEndpoint = `http://user-b:pass-b@127.0.0.1:${address.port}/private-b?token=query-b#fragment-b`

    const first = new SurplusInventoryStore({ endpoint: firstEndpoint, cacheDir })
    const firstResult = await first.refresh()
    assert.equal(firstResult.status, "updated")
    assert.equal(firstResult.inventory?.models[0]?.id, "inventory-a")

    const second = new SurplusInventoryStore({ endpoint: secondEndpoint, cacheDir })
    assert.equal(await second.load(), undefined)
    const secondResult = await second.refresh()
    assert.equal(secondResult.status, "updated")
    assert.equal(secondResult.inventory?.models[0]?.id, "inventory-b")
    assert.equal(await new SurplusInventoryStore({ endpoint: firstEndpoint, cacheDir }).load(), undefined)
    assert.deepEqual(requested, ["/private-a/models?token=query-a", "/private-b/models?token=query-b"])

    const cached = await readFile(path.join(cacheDir, "surplus-models.json"), "utf8")
    assert.equal(cached.includes("private-a"), false)
    assert.equal(cached.includes("private-b"), false)
    assert.equal(cached.includes("query-a"), false)
    assert.equal(cached.includes("query-b"), false)
    assert.equal(cached.includes("user-a"), false)
    assert.equal(cached.includes("pass-a"), false)
    assert.equal(cached.includes("fragment-a"), false)
    assert.equal(cached.includes("user-b"), false)
    assert.equal(cached.includes("pass-b"), false)
    assert.equal(cached.includes("fragment-b"), false)
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    await rm(cacheDir, { recursive: true, force: true })
  }
})

test("a prior canonical cache with a raw endpoint path is migrated on load", async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-cache-migrate-"))
  const endpoint = "https://proxy.example/private-path-secret?token=query-secret"
  const oldEndpoint = "https://proxy.example/private-path-secret"
  const oldQueryHash = createHash("sha256").update("?token=query-secret").digest("hex").slice(0, 16)
  const oldEndpointKey = `${oldEndpoint}#query-${oldQueryHash}`
  const cacheFile = path.join(cacheDir, "surplus-models.json")
  try {
    await writeFile(cacheFile, JSON.stringify({
      version: 2,
      provider: "surplus",
      endpoint: oldEndpoint,
      endpointKey: oldEndpointKey,
      account: "public",
      fetchedAt: 1_000,
      models: [{ id: "cached-model", name: "Cached model" }],
    }))
    const store = new SurplusInventoryStore({ endpoint, cacheDir, now: () => 2_000 })

    const inventory = await store.load()
    assert.equal(inventory?.models[0]?.id, "cached-model")
    assert.equal(inventory?.endpoint, "https://proxy.example")
    assert.equal(inventory?.endpointKey, endpointCacheKey(endpoint))
    const rewritten = await readFile(cacheFile, "utf8")
    assert.equal(rewritten.includes("private-path-secret"), false)
    assert.equal(rewritten.includes("query-secret"), false)
    assert.equal(JSON.parse(rewritten).endpoint, "https://proxy.example")
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
  }
})

test("a failed prior-cache rewrite keeps inventory and warns without exposing endpoint components", async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-cache-migrate-fail-"))
  const endpoint = "https://proxy.example/private-path-secret?token=query-secret"
  const oldEndpoint = "https://proxy.example/private-path-secret"
  const oldQueryHash = createHash("sha256").update("?token=query-secret").digest("hex").slice(0, 16)
  const cacheFile = path.join(cacheDir, "surplus-models.json")
  const oldCache = JSON.stringify({
    version: 2,
    provider: "surplus",
    endpoint: oldEndpoint,
    endpointKey: `${oldEndpoint}#query-${oldQueryHash}`,
    account: "public",
    fetchedAt: 1_000,
    models: [{ id: "cached-model", name: "Cached model" }],
  })
  const warnings: string[] = []
  try {
    await writeFile(cacheFile, oldCache)
    const fileSystem = {
      ...atomicFileSystem,
      readFile: (file: string, encoding: "utf8") => readFile(file, encoding),
      rename: async () => {
        throw new Error("fixture rename failure")
      },
    }
    const store = new SurplusInventoryStore({
      endpoint,
      cacheDir,
      fileSystem,
      warn: (message) => {
        warnings.push(message)
        throw new Error("fixture warning sink failure")
      },
    })

    const inventory = await store.load()
    assert.equal(inventory?.models[0]?.id, "cached-model")
    assert.equal(await readFile(cacheFile, "utf8"), oldCache)
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0]?.includes("private-path-secret"), false)
    assert.equal(warnings[0]?.includes("query-secret"), false)
    assert.deepEqual((await readdir(cacheDir)).filter((name) => name.endsWith(".tmp")), [])
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
  }
})

test("cache temporary creation refuses a pre-planted symlink", async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-cache-symlink-"))
  const protectedFile = path.join(cacheDir, "protected.txt")
  let plantedLink: string | undefined
  try {
    await writeFile(protectedFile, "must remain unchanged")
    const fileSystem = {
      ...atomicFileSystem,
      readFile: (file: string, encoding: "utf8") => readFile(file, encoding),
      open: async (file: string, flags: "wx", mode: number) => {
        plantedLink = file
        await symlink(protectedFile, file)
        return atomicFileSystem.open(file, flags, mode)
      },
    }
    const store = new SurplusInventoryStore({
      cacheDir,
      fileSystem,
      fetcher: async () => new Response(JSON.stringify({ data: [{ id: "surplus-a" }] }), { status: 200 }),
      now: () => 1_000,
    })

    const result = await store.refresh()
    assert.equal(result.status, "updated")
    assert.equal(await readFile(protectedFile, "utf8"), "must remain unchanged")
    assert.equal(result.inventory?.models[0]?.id, "surplus-a")
    assert.equal((await readdir(cacheDir)).some((name) => name === "surplus-models.json"), false)
  } finally {
    if (plantedLink) await unlink(plantedLink)
    await rm(cacheDir, { recursive: true, force: true })
  }
})

test("failed cache replacement preserves the previous cache and cleans the temporary file", async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-cache-replace-fail-"))
  const cacheFile = path.join(cacheDir, "surplus-models.json")
  try {
    const initial = new SurplusInventoryStore({
      cacheDir,
      fetcher: async () => new Response(JSON.stringify({ data: [{ id: "old-model" }] }), { status: 200 }),
      now: () => 1_000,
    })
    await initial.refresh()
    const originalCache = await readFile(cacheFile, "utf8")
    const fileSystem = {
      ...atomicFileSystem,
      readFile: (file: string, encoding: "utf8") => readFile(file, encoding),
      rename: async () => {
        throw new Error("fixture rename failure")
      },
    }
    const replacement = new SurplusInventoryStore({
      cacheDir,
      fileSystem,
      fetcher: async () => new Response(JSON.stringify({ data: [{ id: "new-model" }] }), { status: 200 }),
      now: () => 2_000,
    })

    const result = await replacement.refresh()
    assert.equal(result.status, "updated")
    assert.equal(result.inventory?.models[0]?.id, "new-model")
    assert.equal(await readFile(cacheFile, "utf8"), originalCache)
    assert.deepEqual((await readdir(cacheDir)).filter((name) => name.endsWith(".tmp")), [])
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
  }
})

test("catalog refresh uses a public HTTP fixture without authorization", async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-http-"))
  const httpServer = createServer((request, response) => {
    assert.equal(request.url, "/v1/models?token=fixture-secret/")
    assert.equal(request.headers.authorization, undefined)
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ data: [{ id: "surplus-http", name: "HTTP fixture" }] }))
  })

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject)
      httpServer.listen(0, "127.0.0.1", () => resolve())
    })
    const address = httpServer.address()
    assert.ok(address && typeof address !== "string")
    const store = new SurplusInventoryStore({
      endpoint: `http://127.0.0.1:${address.port}/v1?token=fixture-secret/`,
      cacheDir,
    })
    const result = await store.refresh()
    assert.equal(result.status, "updated")
    assert.equal(result.inventory?.models[0]?.id, "surplus-http")
    assert.equal((await readFile(path.join(cacheDir, "surplus-models.json"), "utf8")).includes("fixture-secret"), false)
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    await rm(cacheDir, { recursive: true, force: true })
  }
})
