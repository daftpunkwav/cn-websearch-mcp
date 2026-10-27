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

No network access: they read files or spawn the built artifact. All four run
in CI and can be run locally.

| File | Role |
|---|---|
| `ci/check_npm_deps_policy.mjs` | Denylist gate: fails when a package banned by `ci/dependency-policy.json` appears in `package-lock.json` (transitive tree and aliases included) or `package.json`. |
| `ci/npm-audit-check.mjs` | Audit gate: fails on any high/critical `npm audit` finding not listed in `ci/npm-audit-allowlist.json`; fails closed on malformed input. CI pipes `npm audit --json` into it. |
| `ci/mcp-handshake-check.ts` | Runtime gate: spawns `dist/index.js` with a clean env and completes one MCP `initialize` handshake. It is the only place the shipped artifact runs on Node 18, the runtime the vitest suite no longer supports. Needs `dist/`, so it runs after `npm run build`. |
| `ci/check_workflow_hardening.mjs` | Workflow gate: fails when a workflow installs packages without `--ignore-scripts`, or when a download in a workflow uses another protocol than HTTPS, or follows a redirect that may leave HTTPS. It reads `.github/workflows/` only, and rejects what it cannot read there - a URL assembled in code, a URL that arrives through a variable or a file, a client it does not know, options in a file. |

The workflow gate reads a workflow file through the modules under
`ci/workflow/`, one responsibility each:

| Module | Role |
|---|---|
| `ci/workflow/shell_line.mjs` | Reads a shell line as the commands it runs: the quoting, the comment, the arguments. |
| `ci/workflow/workflow_lines.mjs` | Reads the `run:` scalar of a workflow file as the commands they run: the block scalars, the folded scalars and the continued lines. |
| `ci/workflow/command_options.mjs` | Reads the options of a command the way the client reads them: the last occurrence wins, and the scheme of a URL is the one the text spells out. |
| `ci/workflow/install_policy.mjs` | Decides whether a package install keeps `--ignore-scripts`. |
| `ci/workflow/download_policy.mjs` | Decides whether a download keeps HTTPS, its TLS version and its redirect protocol. |
| `ci/workflow/workflow_files.mjs` | Reads the workflow files of a directory. |

The live half of `smoke.ts` is not automatable, but its wiring is:
`test/probe.test.ts` drives the same `createRuntime` → `chain` → `probeAll`
path with synthetic keys and an injected fetch, so a probe that stopped
reaching its channels fails in CI instead of against a live upstream.
