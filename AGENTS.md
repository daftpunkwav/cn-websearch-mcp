# Agent working rules

Working rules for coding agents in this repository. The source layout, module
responsibilities, and per-directory details live in
[src/README.md](src/README.md), [src/cli/README.md](src/cli/README.md),
[src/providers/README.md](src/providers/README.md), and
[test/README.md](test/README.md). Machine-local preferences (commit language,
comment style, decoupling rules) live in
[AGENTS.local.md](AGENTS.local.md).

## Git conventions

### Commit messages (Conventional Commits)

```
<type>: <subject>
```

`type` is a standard type such as `feat`/`fix`/`docs`/`refactor`/`chore`/`test`/`perf`;
the subject is imperative, describes the behavior directly, and carries no
internal phase numbers or document-chapter references. One commit does one thing.

Examples: `feat: add aggregate strategy`, `fix: clamp zhipu count to 1..50`

### Branch naming

```
<type>/<kebab-case-description>
```

`type` as above; the description is kebab-case.

## Code conventions

- Comments and file headers are written in English, in the `@file` /
  `@description` / `Responsibilities` style already used across `src/`.
- Runtime-visible strings stay in English — tool descriptions, CLI output, log
  lines and error messages — so clients and scripts get stable, greppable output.
- Every module has a single responsibility; modules with two different concerns
  are split even when small. Cross-cutting concerns (timeout, retry, fallback,
  aggregation, audit) belong to `src/orchestrator.ts`, never to adapters.
- API keys and credential-like strings are never logged, echoed, or written
  into error messages; see `redactSecrets` in `src/errors.ts` and
  `redactedConfig` in `src/cli/render.ts`.
- `SERVER_NAME` / `SERVER_VERSION` in `src/server-info.ts` are the single
  source of truth for the server identity; `test/server-info.test.ts` asserts
  they match `package.json` on every test run.

## Where new code goes

- A new search channel = one adapter file in `src/providers/` + one line in
  the `FACTORIES` map in `src/providers/index.ts` (plus
  `KNOWN_PROVIDERS` in `src/config.ts`; the `<NAME>_*` environment variables
  are derived from the name automatically). Adapters stay thin: request
  construction and response parsing only.
- A new CLI command = one case in `src/cli/index.ts` plus its implementation in
  `src/cli/commands.ts` (or a new file under `src/cli/` for interactive
  behavior). Keep exit-code semantics: `0` success, `1` runtime failure,
  `2` usage error.
- Runtime assembly happens only in `src/runtime.ts` (`createRuntime`). Entry
  points (`src/index.ts`, the CLI) consume the assembled runtime; they do not
  rebuild config or providers themselves.

## Quality gates

```bash
npm run build           # tsc → dist/ (must stay clean)
npm test                # vitest run, all HTTP mocked (no keys needed)
npm run test:coverage   # coverage gate: 95% minimum on src/ (lines/functions/branches/statements)
```

The coverage thresholds are enforced by `vitest.config.ts`; a drop below 95%
fails `npm run test:coverage`. Live-network checks (`npm run smoke`) need real
API keys and are separate from the vitest suite.
