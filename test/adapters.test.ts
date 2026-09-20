import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import plugin, { server, setup } from "../src/index.js"

function catalogResponse() {
  return new Response(
    JSON.stringify({
      data: [
        {
          id: "surplus-a",
          name: "Catalog A",
          context_length: 64000,
          top_provider: { max_completion_tokens: 4096 },
          architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          supported_features: ["tools"],
        },
      ],
    }),
    { status: 200 },
  )
}

test("the V1 adapter uses the native provider model map and structured log body", async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-v1-"))
  const logs: any[] = []
  try {
    const hooks = await server(
      {
        client: { app: { log: async (event: unknown) => logs.push(event) } },
      } as any,
      {
        cacheDir,
        fetcher: async (_url: string, init?: RequestInit) => {
          assert.equal((init?.headers as Record<string, string>)["Authorization"], undefined)
          return catalogResponse()
        },
      } as any,
    )
    const config: any = {
      provider: {
        surplus: {
          models: { "surplus-a": { temperature: 0.2 }, "surplus-missing": {} },
        },
      },
    }

    await hooks.config?.(config)
    assert.deepEqual(Object.keys(config.provider.surplus.models), ["surplus-a"])
    assert.equal(config.provider.surplus.models["surplus-a"].name, "Catalog A")
    assert.equal(config.provider.surplus.models["surplus-a"].temperature, 0.2)
    assert.equal(config.provider.surplus.options.baseURL, "https://api.surplusintelligence.ai/v1")
    assert.ok(logs.some((entry) => entry.body?.service === "opencode-surplus"))
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
  }
})

test("the V2 adapter transforms the provider source and reloads after an initial fetch", async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-v2-"))
  const source = {
    provider: {
      id: "surplus",
      name: "Surplus",
      activation: "enabled",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: "https://api.surplusintelligence.ai/v1" },
    },
    models: new Map([["surplus-a", { id: "surplus-a", modelID: "surplus-a", providerID: "surplus", name: "Configured A" }]]),
  }
  const callbacks: Array<(editor: any) => void> = []
  const state: { models: any[]; reloads: number } = { models: [], reloads: 0 }
  const makeEditor = () => ({
    get: () => source,
    update: (_id: string, update: (provider: any) => void) => update(source.provider),
    models: { set: (_id: string, models: any[]) => { state.models = models } },
    add: ({ models }: { models: any[] }) => { state.models = models },
  })

  try {
    const cleanup = await setup({
      options: {
        cacheDir,
        fetcher: async () => catalogResponse(),
      },
      provider: {
        transform: async (callback: (editor: any) => void) => {
          callbacks.push(callback)
          callback(makeEditor())
          return { dispose: async () => undefined }
        },
        reload: async () => {
          state.reloads += 1
          for (const callback of callbacks) callback(makeEditor())
        },
      },
    } as any)

    assert.equal(state.reloads, 1)
    assert.equal(state.models[0].name, "Configured A")
    assert.equal(state.models[0].limit.context, 64000)
    assert.equal(state.models[0].providerID, "surplus")
    assert.deepEqual(state.models[0].capabilities, { tools: true, input: ["text"], output: ["text"] })
    assert.deepEqual(state.models[0].variants, [])
    assert.equal(state.models[0].status, "active")
    assert.equal(state.models[0].enabled, true)
    assert.equal(source.provider.package, "@opencode/ai/providers/openai-compatible")
    assert.equal(plugin.id, "opencode-surplus")
    await cleanup?.()
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
  }
})
