# test/ agent rules

Layout and coverage details live in [README.md](README.md).

## Placement

- Unit and integration tests live in this directory as `<module>.test.ts`, mirroring the `src/` file name. `src/foo.ts` gets `test/foo.test.ts`.
- When two sources share a file name, qualify the test by path: `test/index.test.ts` for `src/index.ts`, `test/providers-index.test.ts` for `src/providers/index.ts`.
- One test file covers one module and stays self-contained.
- `upstream-contract.test.ts` is the exception: it pins the channel wire contracts across `src/providers/`.
- Subprocess journeys live in [e2e/](e2e/). Follow [e2e/AGENTS.md](e2e/AGENTS.md).

## Hermeticity

- Never put a real API key in a test. Synthetic placeholder strings are allowed.
- Unit tests stub `fetchImpl` and do not open the network.
- A subprocess test that needs a deterministic "no keys" state runs the binary with cwd in a fresh temp directory via `runCliInEphemeralCwd` in `e2e/_helpers.ts`.
- Live upstream checks belong in `scripts/smoke.ts` (`npm run smoke`).

## Conventions

- In-process CLI tests call `runCli` from `src/cli/index.ts` with injected dependencies.
- Subprocess tests call `runCli` or `runCliInEphemeralCwd` from `e2e/_helpers.ts`.
- A test reads or writes `process.env` only to cover the fallback that uses it, and restores every key it changes.
- File headers stay in English, with `@file` and `@description`.
- In `vitest.config.ts`, keep the per-test timeout at 30 seconds and the coverage gate at 95% lines, functions, branches, and statements on `src/`.
