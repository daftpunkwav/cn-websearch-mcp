# cn-websearch-mcp

**One MCP tool, several Chinese LLM search backends.** A [Model Context Protocol](https://modelcontextprotocol.io) server that unifies the official built-in web search of **Kimi (Moonshot)**, **Xiaomi MiMo**, **Zhipu GLM**, and **StepFun** behind a single `web_search` tool — with configurable provider priority, automatic fallback, multi-source aggregation, per-attempt timeout, and one retry on transient failures.

## What it does

Each provider ships web search in a different wire format: Kimi needs a 4-step chat "formula" loop with server-side fiber execution, MiMo expects a `web_search` tool on OpenAI chat completions, Zhipu runs a standalone Search REST API, and StepFun exposes a dedicated `/v1/search` endpoint. This server normalizes all of them into one schema and gives you two strategies:

- **`fallback`** (default) — try providers in *your* priority order, return the first success. Cheap, low latency.
- **`aggregate`** — query several providers in parallel, merge the results, dedupe by URL and tag each item with its source provider. Wider coverage.

```
fallback:   kimi ──✓ 1.2s → return          aggregate:  kimi  ─┐
            stepfun (only if kimi failed)               stepfun ─┼─→ merge + dedupe → return
            zhipu   (only if the above failed)          zhipu   ─┘
```

## Install

Requires Node >= 18. From a checkout:

```bash
npm install
npm run build     # tsc → dist/
```

`npx cn-websearch-mcp` also works once the package is published to npm (it is not yet).

Provide at least one provider API key — via environment variables, a `.env` file, or a JSON config file (see [Configuration](#configuration)). Providers without a key are skipped automatically.

## Use it as an MCP server

Point your MCP client at the built entry point. **Keys go in the client's `env` block** — the server reads `.env` relative to its working directory, which is not necessarily your project.

```json
{
  "mcpServers": {
    "cn-websearch": {
      "command": "node",
      "args": ["/absolute/path/to/cn-websearch-mcp/dist/index.js"],
      "env": {
        "STEPFUN_API_KEY": "sk-...",
        "WEBSEARCH_STRATEGY": "aggregate"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add cn-websearch -e STEPFUN_API_KEY=sk-... -- node /absolute/path/to/cn-websearch-mcp/dist/index.js
```

Running the binary with no arguments starts the stdio MCP server, so existing MCP client configurations keep working.

## Use it in a terminal

The same binary is a CLI, so you can search and test without wiring up a client.

```bash
cn-websearch-mcp                       # start the MCP stdio server (default)
cn-websearch-mcp search "query text"   # one-shot search
cn-websearch-mcp search --strategy aggregate --count 12 "query text"
cn-websearch-mcp status                # effective settings + provider status
cn-websearch-mcp test                  # probe every ready provider once
cn-websearch-mcp repl                  # interactive session
cn-websearch-mcp help                  # full usage
```

Options: `-n/--count <1-50>`, `--strategy fallback|aggregate`, `--providers a,b` (restrict this call), `--no-dedupe`, `-q/--query` (query for `test`), `--json` (raw output for scripting), `-h`, `-v`.

Exit codes: `0` success, `1` runtime failure (search failed / nothing configured), `2` usage error — so scripts and CI can branch on them.

In the interactive session, bare text is a search and `/` commands control the session:

```
cn-websearch> 最近一周国内发布的大模型
cn-websearch> /strategy aggregate      # switch this session to multi-source
cn-websearch> /aggregate rust async    # one-off multi-source search
cn-websearch> /count 12
cn-websearch> /providers stepfun,zhipu # restrict this session
cn-websearch> /test stepfun            # probe one provider
cn-websearch> /status  /config  /json on  /help  /quit
```

## Configuration

Configuration is merged in this order — later layers win:

**built-in defaults → JSON config file → environment variables**

Environment variables win because MCP clients can generally only pass `env`.

### Config file

Put `cn-websearch.config.json` in the working directory; it is picked up automatically. Or point at it explicitly with `WEBSEARCH_CONFIG=/path/to/file.json`.

See [cn-websearch.config.example.json](cn-websearch.config.example.json) for every supported key. A minimal example:

```json
{
  "strategy": "aggregate",
  "providers": {
    "stepfun": { "apiKey": "sk-...", "priority": 10 },
    "zhipu": { "priority": 5, "options": { "searchEngine": "search_pro" } },
    "kimi": { "enabled": false }
  }
}
```

If you put API keys in this file, **do not commit it** — `cn-websearch.config.json` is git-ignored by default for that reason (use `git add -f` if you keep a keyless, shareable config there).

### Choosing provider priority

Two equivalent ways, evaluated in this order:

1. `order` (config file) or `WEBSEARCH_ORDER` (env) — an explicit list, highest priority first: `["stepfun", "zhipu"]`.
2. `priority` per provider — a number, higher goes earlier. Ties are broken alphabetically so the result is deterministic.
3. Neither set → alphabetical default (`kimi, mimo, stepfun, zhipu`).

Set in the config file:

```json
{ "providers": { "stepfun": { "priority": 10 }, "zhipu": { "priority": 5 } } }
```

or by environment:

```bash
WEBSEARCH_ORDER=stepfun,zhipu,kimi
STEPFUN_PRIORITY=10
```

On the command line, `--providers` narrows a single call without changing the configured priority.

### Settings

| Config file | Environment | Default | Meaning |
|---|---|---|---|
| `strategy` | `WEBSEARCH_STRATEGY` | `fallback` | `fallback` = first success wins; `aggregate` = multi-source merge |
| `order` | `WEBSEARCH_ORDER` | alphabetical | Explicit provider priority list |
| `count` | `WEBSEARCH_COUNT` | `8` | Default result count when a tool call omits `count` |
| `timeoutMs` | `WEBSEARCH_TIMEOUT_MS` | `30000` | Budget per attempt; a retry gets a fresh budget, so one provider's worst case is ~2× |
| `maxProviders` | `WEBSEARCH_MAX_PROVIDERS` | `4` | Cap on providers per call (chain length / fan-out) |
| `dedupe` | `WEBSEARCH_DEDUPE` | `true` | Merge duplicate URLs when aggregating |
| — | `WEBSEARCH_CONFIG` | — | Explicit config file path |

Booleans accept `true/false`, `1/0`, `yes/no`, `on/off`. Invalid values are ignored with a warning rather than failing.

### Per-provider settings

Every provider supports the same generic knobs, in the config file or as `<NAME>_<SUFFIX>` environment variables:

`apiKey` (`_API_KEY`), `baseUrl` (`_BASE_URL`), `model` (`_MODEL`), `enabled` (`_ENABLED`), `priority` (`_PRIORITY`), `timeoutMs` (`_TIMEOUT_MS`, overrides the global budget for that provider), and `options` for provider-specific parameters:

| Provider | `options` | Notes |
|---|---|---|
| `kimi` | `maxRounds` (1-5, default 2), `maxTokens` (256-32768, default 8192) | Kimi-specific: rounds of the web-search loop before the final answer |
| `mimo` | `location` (`country`/`region`/`city`, default `country`), `maxKeyword` (1-10, default 3), `forceSearch` (default true) | |
| `stepfun` | `category` | Omitted unless set |
| `zhipu` | `searchEngine` (default `search_std`), `contentSize` (default `high`) | `searchEngine` also readable from `ZHIPU_SEARCH_ENGINE` |

Keys are never logged or echoed: error text is scrubbed of credential-looking strings, and status output only reports whether a key is set.

## Tools

### `web_search`

Input: `{ "query": string, "count"?: integer, "strategy"?: "fallback"|"aggregate", "providers"?: string[] }`.

`count` defaults to your configured `count`, `strategy` to your configured strategy, and `providers` (when given) must name providers that are enabled and have a key — otherwise the call returns a structured error naming the problem rather than silently ignoring it.

Output: normalized results plus an audit trail. In aggregate mode each item carries `source`, and `_meta.providers` lists everyone who answered:

```json
{
  "results": [
    {
      "title": "…",
      "url": "https://…",
      "snippet": "…",
      "content": "optional full text when the provider returns it",
      "published_date": "2026-09-06",
      "source": "stepfun"
    }
  ],
  "_meta": {
    "provider": "stepfun",
    "providers": ["stepfun", "zhipu"],
    "total_latency_ms": 2586,
    "attempts": [
      { "provider": "stepfun", "status": "ok", "latency_ms": 2025 },
      { "provider": "zhipu", "status": "transient_error", "latency_ms": 611, "error": "HttpError: HTTP 429: …" }
    ]
  }
}
```

### `provider_status`

Read-only: effective strategy and settings, and per provider whether it is enabled, has a key, and is in the active chain.

## Fallback & failure semantics

- Only providers that are enabled **and** have a key participate. `fallback` walks them in priority order; `aggregate` queries them in parallel.
- Per attempt: one wall-clock budget (`timeoutMs`); hung requests are aborted and recorded as `timeout`.
- Transient failures (network errors, HTTP 5xx, 429, timeout) are retried **once**, then the next provider is tried.
- Permanent failures (HTTP 4xx) skip the retry and move on immediately.
- In `aggregate`, partial failure is not failure: successful providers' results are returned and the failures stay in `_meta.attempts`.
- Every attempt is recorded in `_meta.attempts` — success, retry, timeout or error.
- If everyone fails, `web_search` returns a structured error containing the full attempt list.

## Provider support matrix

| Provider | Channel used | Structured results | Full text |
|---|---|---|---|
| StepFun | `POST /v1/search` REST API | ✅ | ✅ (`content`) |
| Zhipu GLM | `POST /api/paas/v4/web_search` standalone API | ✅ | summary |
| MiMo | OpenAI chat completions + `web_search` tool | citations | ✗ (LLM answer in `_meta.answer`) |
| Kimi | chat "web-search formula" 4-step loop | reference URLs | ✗ (LLM answer in `_meta.answer`) |

Note on Kimi/MiMo: these providers return an LLM-synthesized answer plus citations rather than a plain result list. This server surfaces the citations as results and puts the synthesized answer in `_meta.answer` (labelled per provider when aggregating several).

## Development

```bash
npm install
npm run build          # tsc → dist/
npm test               # vitest, all HTTP mocked (no keys needed)
npm run test:coverage  # coverage gate: 95% minimum on src/
npm run smoke          # real requests against every ready provider, prints a latency table
npm run cli -- repl    # run the CLI from source via tsx
```

### Conventions

- **Comments and file headers are written in English.**
- **Runtime-visible strings stay in English** — tool descriptions, CLI output, log lines and error messages — so clients and scripts get stable, greppable output.
- `SERVER_NAME` / `SERVER_VERSION` in `src/server-info.ts` are the single source of truth for the server identity; `test/server-info.test.ts` asserts they match `package.json` on every test run.
- Layering is one-directional: `types` / `errors` / `config-file` / `normalize` at the bottom, then `config` / `http`, then `orchestrator` / `probe`, then `providers`, then `runtime` / `tools` / `cli`. `madge --circular` is clean.

## License

[MIT](LICENSE)
