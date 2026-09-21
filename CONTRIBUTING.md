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

## Security

Do not commit API keys. `.env` and `cn-websearch.config.json` are git-ignored
for exactly that reason. See [SECURITY.md](SECURITY.md).
