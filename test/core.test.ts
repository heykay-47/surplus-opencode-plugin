import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"
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
    assert.equal(result.inventory?.endpoint.includes("secret"), false)
    assert.equal((await readFile(path.join(cacheDir, "surplus-models.json"), "utf8")).includes("secret-value"), false)
    assert.equal(safeEndpointForLog(`${DEFAULT_ENDPOINT}?token=secret-value/`), DEFAULT_ENDPOINT)
    assert.equal(normalizeEndpoint(`https://user:pass@api.surplusintelligence.ai/v1`), DEFAULT_ENDPOINT)
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
