# test/ agent rules

Working rules for coding agents in the test suite. Layout and coverage details
live in [README.md](README.md).

## Placement

- Unit/integration tests go in `test/` as `<module>.test.ts`, mirroring the
  `src/` file name. A new `src/foo.ts` means a new `test/foo.test.ts`.
- Subprocess end-to-end tests go in [e2e/](e2e/), one journey per file
  (protocol round-trip, CLI process behavior, config priority, build
  artifact). Shared scaffolding lives in `e2e/_helpers.ts`; vitest only
  collects `*.test.ts` files, and the underscore prefix marks the file as
  scaffolding rather than a suite.

## Hermeticity

- Never inject real API keys into any test. Unit tests stub `fetchImpl`; e2e
  tests use `cleanEnv()` from `_helpers.ts`, which strips every provider and
  gateway variable so the subprocess sees no usable keys. Tests that need a
  deterministic "no keys" state must run the binary with cwd in a fresh temp
  dir (`runCliInEphemeralCwd`), because the project root's real `.env` would
  otherwise be picked up by the in-process dotenv loader.
- Live upstream checks belong to `scripts/smoke.ts` (`npm run smoke`), never
  to vitest.

## Conventions

- One test file tests one module or one journey; keep each file
  self-contained.
- Prefer driving the CLI through `runCli()`/`runCliInEphemeralCwd()` or the
  injected-dependency APIs over asserting on global process state.
- E2E tests exercise `dist/index.js` — run `npm run build` before
  `npm test` when `src/` changed, or the subprocess runs stale code.
