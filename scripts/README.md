# scripts/

Utilities that run against the real network. They are excluded from the
vitest suite and from coverage (`vitest.config.ts`) — tests never touch live
upstreams, these scripts exist precisely for that.

| File | Role |
|---|---|
| `smoke.ts` | Live-network smoke probe (`npm run smoke`). Loads `.env`, assembles the runtime, probes every ready channel once with a fixed query (`SMOKE_QUERY` overridable), prints a markdown latency table, then runs one full search under the configured strategy. Requires at least one real API key; never prints secrets. |
| `mcp-probe.mjs` | Manual MCP stdio debugging helper: spawns `dist/index.js`, sends framed `initialize` requests, and reports whether the child sees stdin. Used to diagnose transport/startup issues; not part of any automated gate. |

`mcp-probe.mjs` spawns `dist/index.js`, so run `npm run build` first;
`smoke.ts` runs from source through tsx and needs no build.

## ci/ — offline CI gates

No network and no install required; both run in CI and can be run locally.

| File | Role |
|---|---|
| `ci/check_npm_deps_policy.mjs` | Denylist gate: fails when a package banned by `ci/dependency-policy.json` appears in `package-lock.json` (transitive tree and aliases included) or `package.json`. |
| `ci/npm-audit-check.mjs` | Audit gate: fails on any high/critical `npm audit` finding not listed in `ci/npm-audit-allowlist.json`; fails closed on malformed input. CI pipes `npm audit --json` into it. |

The live half of `smoke.ts` is not automatable, but its wiring is:
`test/probe.test.ts` drives the same `createRuntime` → `chain` → `probeAll`
path with synthetic keys and an injected fetch, so a probe that stopped
reaching its channels fails in CI instead of against a live upstream.
