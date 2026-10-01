# src/ agent rules

The module map and layering diagram live in [README.md](README.md).

## Layering

- Dependencies point one way only. Follow the diagram in [README.md](README.md). A lower layer never imports an upper layer.
- `types.ts`, `errors.ts`, and `normalize.ts` stay free of internal imports beyond each other.
- `config-file.ts` and `dotenv.ts` are the only modules that read the disk.
- `config.ts` never reads or writes the disk. `runtime.ts` passes config-file content in.
- Per-attempt timeout, the single transient retry and its backoff, caller cancellation, fallback walking, parallel aggregation, and `_meta.attempts` live only in `orchestrator.ts`.
- Adapters in `providers/` stay limited to request construction and response parsing. See [providers/AGENTS.md](providers/AGENTS.md).
- Provider-name rules — normalization, unknown names, and slots that are not usable — live only in `provider-selection.ts`. The MCP tool layer, the one-shot CLI, and the REPL all call it.
- Runtime assembly happens only in `runtime.ts` (`createRuntime`). Entry points consume that runtime. They do not re-resolve config or rebuild providers.
- `index.ts` is the only file under `src/` that imports `@modelcontextprotocol/sdk`.

## Adding code

- New provider: [providers/AGENTS.md](providers/AGENTS.md).
- New CLI command: [cli/AGENTS.md](cli/AGENTS.md).
- New MCP-facing behavior: extend `tools.ts`. It receives the injected `chain` and calls the orchestrator. It does not import a provider adapter.

## Invariants

- Never print or log API keys or credential-like strings. Use `redactSecrets` in `errors.ts` and `redactedConfig` in `cli/render.ts` at the boundary.
- An error message returned to a caller goes through `summarizeError`, or is written from already-redacted text. Never return a raw `err.message`. Top-level fatal handlers may log the whole error to stderr.
- Strip control characters from untrusted upstream text only in `str` and `normalizeDate` (`normalize.ts`). Adapters and the renderer do not add a second sanitizer.
- A blank configuration value means "not set" at every layer. Keep that rule in `config.ts` when adding a field.
- Invalid configuration input never throws. Warn and fall back in `config.ts`, `config-file.ts`, and `runtime.ts`.
- When a public function depends on env, warn, fetch, streams, or signals, those are arguments.
- Move `SERVER_VERSION` in `server-info.ts` together with `version` in `package.json`. `test/server-info.test.ts` asserts the match.
- File headers stay in English, in the `@file` / `@description` / `Responsibilities` style.
