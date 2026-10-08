# Contributing

## Development setup

Requires Node >= 18.

```bash
npm install
npm run lint          # eslint (Airbnb style guide) over src/, test/, scripts/ and config files
npm run build         # tsc → dist/
npm run typecheck     # tsc over src/, test/, scripts/ and vitest.config.ts (no emit)
npm test              # vitest run, all HTTP mocked (no API keys needed)
npm run test:coverage # test run plus the coverage gate (95% minimum on src/)
```

The end-to-end tests in `test/e2e/` exercise the built `dist/index.js`, so run
`npm run build` after changing `src/` and before `npm test`. Live-network
checks (`npm run smoke`) need real API keys and are not part of the test suite.

## Style guide

The codebase follows the [Airbnb style guide](https://github.com/airbnb/javascript),
enforced by ESLint (`eslint-config-airbnb-extended`, base + TypeScript presets).
`npm run lint` must be clean before a PR; `npm run lint:fix` applies the
auto-fixable subset. The deliberate deviations from the stock presets live in
`eslint.config.mjs`, each with a comment stating why — read it before adding
another one.

## Pull requests

- One change per pull request, described in imperative mood.
- The full gate (`npm run lint` + `npm run build` + `npm run typecheck` +
  `npm run test:coverage`) must pass locally before opening a PR; CI runs the
  same steps.
- New runtime code needs tests; the coverage thresholds in `vitest.config.ts`
  are enforced, not advisory.
- Comments and file headers are written in English, in the `@file` /
  `@description` / `Responsibilities` style used across `src/`.

## Upgrading `@modelcontextprotocol/sdk`

The SDK is the only runtime dependency, and every touch point sits in the entry
layer — nothing else in `src/` imports it:

| Touch point | What it uses |
|---|---|
| `src/index.ts:16-18` | `Server`, `StdioServerTransport`, `CallToolRequestSchema`, `ListToolsRequestSchema`, `CallToolResult` |
| `src/index.ts:38-48` | the `extra` argument of a `setRequestHandler` callback — `extra.signal` carries MCP client cancellation |
| `test/e2e/mcp-stdio.test.ts:21-22` | `Client` and `StdioClientTransport`, driving a real initialize → tools/list → tools/call round trip |
| `test/index.test.ts:7` | the two request schemas, for handler-level assertions |

Those three deep import specifiers (`server/index.js`, `server/stdio.js`,
`types.js`) are the SDK's own documented entry points, not internal files, so a
major bump breaks them only if the SDK changes its published layout.

There is deliberately **no transport port abstraction**: there is exactly one
transport, no second scenario, and a wrapper over three constructor calls would
cost a layer without buying a seam.

To upgrade:

1. `npm install @modelcontextprotocol/sdk@<version>` and read the release notes
   for anything under `server/`, `types.js` or `Client`.
2. `npm run typecheck` — the deep imports are type-checked, so a moved or
   renamed export fails here first, before anything runs.
3. `npm run build && npm run test:coverage` — `test/e2e/mcp-stdio.test.ts` speaks
   the real protocol against the built binary, so a wire-level or handler-signature
   change surfaces as a failing e2e test rather than at a client's request.
4. Confirm `extra.signal` still fires on cancellation; the orchestrator's
   "cancelled" verdict depends on it and no unit test can substitute for the
   live handshake.

A major bump is a separate decision: it changes the dependency contract of a
published package, so get it confirmed before landing.

## Runtime support

`engines.node` is `>=18` and the CI matrix is Node 18/20/22. The shipped code
was exercised against **18.20.8, 20.19.5, 22.21.1 and 24.15.0**; the global
`fetch`, its `Response.body` stream, `AbortController.abort(reason)` and
`signal.reason` all behave identically on each. Early 18.x releases are covered
by the matrix rather than by measurement — see the `combinedSignal` comment in
`src/http.ts` for the one API that is genuinely unavailable there.

## Commits

Conventional Commits, one commit does one thing:

```
<type>: <subject>
```

`type` is a standard type (`feat`/`fix`/`docs`/`refactor`/`chore`/`test`/`perf`);
the subject is imperative, in English, and describes the behavior directly.

## Troubleshooting

### `npm ci` fails in CI but works locally

`npm ci` is strict about lock-file consistency, and CI runners ship npm 10
while a local install may use npm 11. Two failure modes have bitten this
repo:

1. **Version drift** — `package.json` was bumped but
   `package-lock.json` still carries the old root version. `npm ci` fails
   with "can only install packages when your package.json and
   package-lock.json are in sync". The test suite guards this: keep the
   `package-lock.json` root version matching `package.json` (or just run
   `npm install` after a version bump).
2. **Newer-npm lock file** — a lock written by npm 11 can contain peer
   resolution entries that npm 10 rejects, e.g. "Missing: @types/node@…
   from lock file", failing every matrix job in about a second. Fix by
   regenerating the lock with the npm version CI uses:

   ```bash
   npm exec -y --package=npm@10.7.0 -- npm install --package-lock-only
   ```

Verify with both npm versions before pushing:

```bash
npm exec -y --package=npm@10.7.0 -- npm ci --dry-run
npm ci --dry-run
```

## Security

Do not commit API keys. `.env` and `cn-websearch.config.json` are git-ignored
for exactly that reason. See [SECURITY.md](SECURITY.md).
