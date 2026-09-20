# test/e2e/

End-to-end tests. Unlike the unit tests in [../](..) — which import `src/`
directly and stub every boundary — the tests here spawn the built
`dist/index.js` as a real subprocess and talk to it the way an external
consumer would:

- `mcp-stdio.test.ts` drives the MCP stdio server through the
  `Content-Length`-framed JSON-RPC 2.0 the SDK uses (initialize → tools/list →
  tools/call round-trips).
- `cli-process.test.ts` runs one-shot CLI commands and asserts on exit codes
  and output.
- `config-priority.test.ts` verifies the defaults → config file → environment
  precedence against real process launches.
- `build-artifact.test.ts` checks the compiled entry point directly.

## Shared infrastructure

`_helpers.ts` provides everything the journeys above reuse:

- `cleanEnv()` — an env map with every provider and gateway variable removed,
  so a subprocess can never reach a real upstream API.
- `freshTempDir()` / `runCliInEphemeralCwd()` — run the binary with cwd in a
  throwaway directory, so the project root's real `.env` cannot leak in via
  the in-process dotenv loader.
- `runCli()` / `spawnServer()` / `attachClient()` — subprocess running and a
  minimal MCP stdio client.

These helpers must never carry real API keys. Live-network verification lives
in `scripts/smoke.ts` and runs via `npm run smoke`, outside vitest.

Because the tests exercise `dist/index.js`, run `npm run build` after changing
`src/` and before `npm test`; otherwise the subprocess runs stale code.
