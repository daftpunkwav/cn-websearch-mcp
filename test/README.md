# test/

The vitest suite for the package. Everything here runs with `npm test` under
`vitest.config.ts` (30 s per-test ceiling, because end-to-end tests spawn real
subprocesses; unit tests finish in milliseconds). All HTTP is mocked — no API
keys are needed and no real upstream is contacted.

## Layout

- `*.test.ts` (repo-root level of `test/`): unit and integration tests, one
  file per module under test, mirroring the `src/` file name:
  `src/config.ts` → `test/config.test.ts`, `src/orchestrator.ts` →
  `test/orchestrator.test.ts`, and so on (`test/providers-index.test.ts` covers
  `src/providers/index.ts`; the path qualifier keeps it distinct from
  `test/index.test.ts`, which covers `src/index.ts`). These import `../src/...`
  directly and inject fakes (env maps, `warn` spies, `fetchImpl` stubs) — no
  network, no disk.
- `upstream-contract.test.ts`: frozen fixtures for the four channel adapters.
  It spans `src/providers/*.ts` rather than mirroring one file, because what it
  pins is the wire contract each third-party API owns — the request an adapter
  builds and the mapping it performs on a full documented response body. See
  the file header for what these fixtures can and cannot detect.
- [e2e/](e2e/): end-to-end tests that spawn the built `dist/index.js` as a
  real subprocess and speak MCP stdio framing or the CLI protocol. See
  [e2e/README.md](e2e/README.md).

## Type checking

`npm run typecheck` runs `tsconfig.check.json`, which extends the build config
and covers `src/`, `test/`, `scripts/` and `vitest.config.ts`. The build's own
`tsconfig.json` emits `dist/` from `src/` alone, and vitest transpiles without
type checking, so without this step a type error in a test or in the smoke
script would reach CI unnoticed. `noUnusedLocals` / `noUnusedParameters` are on
in the shared base config, so a dead import or an unused parameter fails the
check.

## Coverage gate

`npm run test:coverage` enforces a 95% minimum on `src/` for lines, functions,
branches and statements (`vitest.config.ts`). `src/types.ts` is inside that
tree, but it carries only contracts and the strategy vocabulary with no
branching, so it stays at 100% on its own; `test/` + `scripts/` are outside the
measured tree because `include` is limited to `src/**`. A change that drops
coverage below the gate fails the run — add or extend unit tests rather than
lowering the threshold.
