import { server as v1Server } from "./v1.js"
import { setup as v2Setup } from "./v2.js"

export * from "./core.js"

// Keep the public declaration usable when only one optional host package is
// installed; each adapter retains its precise private host type internally.
type PublicEntrypoint = (...args: any[]) => any
export const server: PublicEntrypoint = v1Server as PublicEntrypoint
export const setup: PublicEntrypoint = v2Setup as PublicEntrypoint

const plugin = {
  id: "opencode-surplus",
  setup,
  server,
}

export default plugin
