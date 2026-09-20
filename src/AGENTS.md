# src/ agent rules

Working rules for coding agents in the runtime source tree. The module map and
layering diagram live in [README.md](README.md).

## Layering discipline

- Dependencies point one way only (see the diagram in [README.md](README.md)):
  never import an upper layer from a lower one. `types.ts` / `errors.ts` /
  `normalize.ts` must stay free of internal imports beyond each other;
  `config.ts` is pure (it never touches the disk — config file content is
  passed in by `runtime.ts`).
- Cross-cutting concerns — per-attempt timeout, the single transient retry,
  fallback walking, parallel aggregation, the `_meta.attempts` audit trail —
  live exclusively in `orchestrator.ts`. Adapters (`providers/`) stay thin:
  request construction and response parsing only.
- Runtime assembly happens only in `runtime.ts` (`createRuntime`). Entry
  points consume the assembled runtime; they never re-resolve config or
  rebuild providers.

## Adding code

- **New provider**: one adapter file in `providers/` implementing
  `SearchProvider` + one entry in the `FACTORIES` map in
  [providers/index.ts](providers/index.ts) + the name in `KNOWN_PROVIDERS` in
  [config.ts](config.ts). Per-slot `<NAME>_*` environment variables are
  derived from the name automatically; add slot-specific options handling
  inside the adapter. Return `_meta.provider` (and `_meta.answer` where the
  channel synthesizes one); never fill `attempts` or `total_latency_ms` — the
  orchestrator owns those.
- **New CLI command**: a case in [cli/index.ts](cli/index.ts) plus its
  implementation in [cli/commands.ts](cli/commands.ts). Preserve the exit-code
  contract (`0` / `1` / `2`, defined as `EXIT` in `cli/index.ts`) and route
  all output through the injected streams.
- **New MCP-facing behavior**: extend [tools.ts](tools.ts); keep it free of
  direct provider imports — it only knows the injected `chain` and the
  orchestration entry point.

## Invariants to preserve

- No code path may print or log API keys or credential-like strings; use
  `redactSecrets` (errors) and `redactedConfig` (cli/render) at the boundary.
- Invalid configuration input never throws: warn and fall back
  (`config.ts`, `config-file.ts`, `runtime.ts`).
- Every public function stays injectable (env, warn, fetch, streams), so tests
  cover each branch without network or disk access.
- `SERVER_VERSION` in `server-info.ts` must move together with the `version`
  field in `package.json`; the test suite asserts the match.
