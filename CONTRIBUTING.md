# Contributing

## Development setup

Requires Node >= 18.

```bash
npm install
npm run build          # tsc → dist/
npm test               # vitest run, all HTTP mocked (no API keys needed)
npm run test:coverage  # test run plus the coverage gate (95% minimum on src/)
```

The end-to-end tests in `test/e2e/` exercise the built `dist/index.js`, so run
`npm run build` after changing `src/` and before `npm test`. Live-network
checks (`npm run smoke`) need real API keys and are not part of the test suite.

## Pull requests

- One change per pull request, described in imperative mood.
- The full gate (`npm run build` + `npm run test:coverage`) must pass locally
  before opening a PR; CI runs the same steps.
- New runtime code needs tests; the coverage thresholds in `vitest.config.ts`
  are enforced, not advisory.
- Comments and file headers are written in English, in the `@file` /
  `@description` / `Responsibilities` style used across `src/`.

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
