# scripts/ agent rules

The script table lives in [README.md](README.md).

## Boundary

- These scripts call the live network. Vitest does not collect them, and the coverage include stays `src/**`.
- Never print API keys or credential-like strings.
- `src/` and the vitest suite do not import these scripts.

## smoke.ts

- The entry is `npm run smoke`. It runs from source through tsx and does not need a build.
- Load config with `loadDotEnv` and `createRuntime`. Probe the ready chain with `probeAll`, then run one `runSearch` under the configured strategy.
- Exit `1` when the chain is empty.
- `SMOKE_QUERY` overrides the built-in query.
- `test/probe.test.ts` covers the `createRuntime` → chain → `probeAll` path with synthetic keys and an injected fetch.

## mcp-probe.mjs

- Manual stdio helper. It is not part of CI.
- It spawns `dist/index.js`. Run `npm run build` before using it.
