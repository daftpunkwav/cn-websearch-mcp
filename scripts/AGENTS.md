# scripts/ agent rules

The script table lives in [README.md](README.md).

## Boundary

- Vitest does not collect these scripts, and the coverage include stays `src/**/*.ts`.
  The glob stops at `.ts` on purpose: the v8 provider reports every file `include`
  matches, so a broad `src/**` glob pulls the Markdown files next to the sources
  into the report as uncovered files.
- Never print API keys or credential-like strings.
- `src/` and the vitest suite do not import these scripts.

## smoke.ts

- This script calls the live network.
- The entry is `npm run smoke`. It runs from source through tsx and does not need a build.
- Load config with `loadDotEnv` and `createRuntime`. Probe the ready chain with `probeAll`, then run one `runSearch` under the configured strategy.
- Exit `1` when the chain is empty.
- `SMOKE_QUERY` overrides the built-in query.
- `test/probe.test.ts` covers the `createRuntime` → chain → `probeAll` path with synthetic keys and an injected fetch.

## mcp-probe.mjs

- Local stdio handshake. It spawns `dist/index.js`, sends MCP `initialize` frames, and does not run a search.
- It is not part of CI. Run `npm run build` before using it.

## ci/mcp-handshake-check.ts

- CI gate, and the only place the shipped artifact runs on Node 18: the vitest
  suite supports Node `^20`, `^22` and `>=24`, so the Node 18 matrix row
  compiles the package and then runs this check.
- It spawns `dist/index.js` with a clean env and completes one MCP `initialize`
  handshake. The entry is `npm run handshake-check`; it runs through tsx, because
  Node 18 runs neither the TypeScript under `test/e2e/` nor the vitest runner.
- It needs `dist/`, so it runs after `npm run build`.

## ci/check_workflow_hardening.mjs

- CI gate over `.github/workflows/`: a package install must run with
  `--ignore-scripts`, and a download must use HTTPS and must not follow a
  redirect out of HTTPS.
- The check is text-based. The repository has no YAML parser in its toolchain,
  and a workflow line is where these flags live.
- The gate reads a workflow file through the modules under `ci/workflow/`, one
  responsibility each: the shell text, the workflow lines, the command options,
  the install policy, the download policy, and the reading of the files. A
  rule that does not fit its module belongs in the module that owns the
  decision, not in the entry.
- What it cannot read from the text it rejects rather than accepts: a URL
  assembled in code, a client it does not know, options in a file. The rest
  of the gap is tracked in [#39](https://github.com/daftpunkwav/cn-websearch-mcp/issues/39).
- `test/check_workflow_hardening.test.ts` covers it, including that the
  workflow still runs the gate.
- A workflow that needs a different protection changes this checker on
  purpose, in the same commit as the workflow.
