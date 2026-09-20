# test/

The vitest suite for the package. Everything here runs with `npm test` under
`vitest.config.ts` (30 s per-test ceiling, because end-to-end tests spawn real
subprocesses; unit tests finish in milliseconds). All HTTP is mocked — no API
keys are needed and no real upstream is contacted.

## Layout

- `*.test.ts` (repo-root level of `test/`): unit and integration tests, one
  file per module under test, mirroring the `src/` file name:
  `src/config.ts` → `test/config.test.ts`, `src/orchestrator.ts` →
  `test/orchestrator.test.ts`, and so on (`registry.test.ts` covers
  `src/providers/index.ts`). These import `../src/...` directly and inject
  fakes (env maps, `warn` spies, `fetchImpl` stubs) — no network, no disk.
- [e2e/](e2e/): end-to-end tests that spawn the built `dist/index.js` as a
  real subprocess and speak MCP stdio framing or the CLI protocol. See
  [e2e/README.md](e2e/README.md).

## Coverage gate

`npm run test:coverage` enforces a 95% minimum on `src/` for lines, functions,
branches and statements (`vitest.config.ts`). `src/types.ts` is type-only and
`scripts/` is live-network code, so both are excluded from the metric. A
change that drops coverage below the gate fails the run — add or extend unit
tests rather than lowering the threshold.
