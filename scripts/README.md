# scripts/

Utilities that run against the real network. They are excluded from the
vitest suite and from coverage (`vitest.config.ts`) — tests never touch live
upstreams, these scripts exist precisely for that.

| File | Role |
|---|---|
| `smoke.ts` | Live-network smoke probe (`npm run smoke`). Loads `.env`, assembles the runtime, probes every ready channel once with a fixed query (`SMOKE_QUERY` overridable), prints a markdown latency table, then runs one full search under the configured strategy. Requires at least one real API key; never prints secrets. |
| `mcp-probe.mjs` | Manual MCP stdio debugging helper: spawns `dist/index.js`, sends a framed `initialize` request, and reports whether the child sees stdin. Used to diagnose transport/startup issues; not part of any automated gate. |

`mcp-probe.mjs` spawns `dist/index.js`, so run `npm run build` first;
`smoke.ts` runs from source through tsx and needs no build.
