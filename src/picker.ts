import type { CatalogModel } from "./core.js"

function searchableText(model: CatalogModel): string {
  return [model.id, model.name, model.description, model.provider].filter(Boolean).join(" ").toLocaleLowerCase()
}

export function filterCatalogModels(models: CatalogModel[], query: string): CatalogModel[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return [...models]
  return models.filter((model) => {
    const text = searchableText(model)
    return terms.every((term) => text.includes(term))
  })
}

function dollarsPerMillion(value: number | undefined): string | undefined {
  if (value === undefined) return undefined
  return `$${(value * 1_000_000).toFixed(value * 1_000_000 >= 10 ? 0 : 2)}/M`
}

export function modelDescription(model: CatalogModel): string {
  const parts: string[] = []
  if (model.contextLength !== undefined) parts.push(`${model.contextLength.toLocaleString()} context`)
  const input = dollarsPerMillion(model.pricing?.input)
  const output = dollarsPerMillion(model.pricing?.output)
  if (input || output) parts.push(`${input || "?"} in / ${output || "?"} out`)
  if (model.provider) parts.push(model.provider)
  return parts.join(" · ") || model.id
}

export function modelSelectionMap(ids: string[], existing: unknown): Record<string, unknown> {
  const existingModels = typeof existing === "object" && existing !== null && !Array.isArray(existing)
    ? existing as Record<string, unknown>
    : {}
  return Object.fromEntries(ids.map((id) => {
    const value = existingModels[id]
    return [id, typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}]
  }))
}

export function toggleModel(selected: Set<string>, id: string): Set<string> {
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}
