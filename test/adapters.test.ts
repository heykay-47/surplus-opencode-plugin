import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
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

test("the V1 adapter logs an endpoint fingerprint without configured URL components", async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-v1-endpoint-log-"))
  const logs: any[] = []
  const endpoint = "https://proxy.example/private-path-secret?token=query-secret"
  try {
    const hooks = await server(
      {
        client: { app: { log: async (event: unknown) => logs.push(event) } },
      } as any,
      {
        cacheDir,
        fetcher: async () => catalogResponse(),
      } as any,
    )
    const config: any = {
      provider: {
        surplus: {
          options: { baseURL: endpoint },
          models: { "surplus-a": {} },
        },
      },
    }

    await hooks.config?.(config)

    const logged = JSON.stringify(logs)
    assert.ok(logged.includes("https://proxy.example"))
    assert.equal(logged.includes("private-path-secret"), false)
    assert.equal(logged.includes("query-secret"), false)
    assert.ok(logged.includes("endpoint "))
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
  }
})


function recordingIntegrationEditor() {
  const integrations = new Map<string, { id: string; name: string }>()
  const methods: any[] = []
  return {
    integrations,
    methods,
    update: (id: string, update: (item: any) => void) => {
      const item = integrations.get(id) ?? { id, name: id }
      update(item)
      integrations.set(id, item)
    },
    method: { update: (input: any) => methods.push(input) },
  }
}

test("the V2 adapter transforms the provider source and reloads after an initial fetch", async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-v2-"))
  await mkdir(path.join(cacheDir, ".git"))
  await writeFile(path.join(cacheDir, "opencode.json"), JSON.stringify({ providers: { surplus: {
    package: "@opencode/ai/providers/openai-compatible", models: { "surplus-a": {} },
  } } }))
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
  const integrationEditor = recordingIntegrationEditor()
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
      location: { directory: cacheDir },
      options: {
        cacheDir,
        fetcher: async () => catalogResponse(),
      },
      integration: {
        transform: async (callback: (editor: any) => void) => {
          callback(integrationEditor)
          return { dispose: async () => undefined }
        },
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

test("the V2 adapter reads native model selections before the provider exists in the registry", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "opencode-surplus-v2-config-"))
  const cacheDir = path.join(project, "cache")
  await mkdir(path.join(project, ".git"))
  await writeFile(path.join(project, "opencode.json"), JSON.stringify({
    providers: { surplus: {
      settings: { baseURL: "https://proxy.example/v1" },
      models: { "surplus-a": { name: "Project label" } },
    } },
  }))
  const integrationEditor = recordingIntegrationEditor()
  const callbacks: Array<(editor: any) => void> = []
  const state: { provider?: any; models: any[]; reloads: number } = { models: [], reloads: 0 }
  const editor = () => ({
    get: () => undefined,
    add: ({ info, models }: { info: any; models: any[] }) => { state.provider = info; state.models = models },
  })
  try {
    const cleanup = await setup({
      location: { directory: project },
      options: { cacheDir, fetcher: async () => catalogResponse() },
      integration: {
        transform: async (callback: (editor: any) => void) => {
          callback(integrationEditor)
          return { dispose: async () => undefined }
        },
      },
      provider: {
        transform: async (callback: (editor: any) => void) => {
          callbacks.push(callback)
          callback(editor())
          return { dispose: async () => undefined }
        },
        reload: async () => {
          state.reloads++
          for (const callback of callbacks) callback(editor())
        },
      },
    } as any)

    assert.equal(state.reloads, 1)
    assert.equal(state.provider?.settings.baseURL, "https://proxy.example/v1")
    assert.deepEqual(state.models.map((model) => model.id), ["surplus-a"])
    assert.equal(state.models[0].name, "Project label")
    assert.equal(state.provider?.integrationID, "surplus")
    assert.equal(integrationEditor.integrations.get("surplus")?.name, "Surplus Intelligence")
    assert.deepEqual(integrationEditor.methods.map((input) => input.method), [
      { type: "key", label: "Surplus API key" },
      { type: "env", names: ["SURPLUS_API_KEY"] },
    ])
    await cleanup?.()
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})
