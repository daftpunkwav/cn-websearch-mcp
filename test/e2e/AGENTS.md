# test/e2e/ agent rules

The journey list and helper catalog live in [README.md](README.md).

## Placement

- One journey per `*.test.ts` file: the MCP stdio round-trip, CLI process behavior, config priority, and the build artifact stay in separate files.
- Shared scaffolding lives only in `_helpers.ts`. Vitest collects `*.test.ts`. The underscore prefix marks a file as scaffolding.

## Process boundary

- Spawn `dist/index.js`. Do not import `src/` in place of the built binary.
- After a change under `src/`, run `npm run build` before `npm test`.
- Build the subprocess environment with `cleanEnv()`. Do not pass `process.env` through.
- A case that needs "no keys" sets cwd to a fresh temp directory (`freshTempDir` / `runCliInEphemeralCwd`).
- `cleanEnv` overrides use synthetic values only. A fake key is allowed when the journey asserts config precedence.
- Live upstream calls belong in `scripts/smoke.ts`.
