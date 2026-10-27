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
- The gate reads the `run:` scalar of every step as YAML, and reads the shell
  in it as the commands it runs. The repository has no YAML parser in its
  toolchain, so the reader covers the shapes a step takes and nothing more.
- The gate reads a workflow file through the modules under `ci/workflow/`, one
  responsibility each: the shell text, the workflow lines, the command options,
  the install policy, the download policy, and the reading of the files. A
  rule that does not fit its module belongs in the module that owns the
  decision, not in the entry.
- What it cannot read from the text it rejects rather than accepts: a URL
  assembled in code, a URL that arrives through a variable or a file, a
  client it does not know, and options in a file.
- A URL the text of a command carries is only accepted next to a client the
  gate can check (curl or wget) or next to the program the command runs, when
  that program reads the URL as a value: a package manager, a source tree, or
  a program that prints it. A name behind the program is an argument of that
  program and exempts nothing.
- The one residual is a download under a client the gate does not know whose
  URL the text does not spell out: a client the gate knows has to carry a URL
  it can read, while a client it does not know gives the gate nothing to
  reject when the URL arrives through a variable or a file.
- The gate reads the `run:` key of a step. A `run:` key of another mapping,
  such as an input of an action, holds no command and is not read.
- `test/check_workflow_hardening.test.ts` covers it, including that the
  workflow still runs the gate.
- A workflow that needs a different protection changes this checker on
  purpose, in the same commit as the workflow.
