# cn-websearch-mcp

> Language: **English** | [简体中文](README.zh.md)

**One MCP tool, several built-in web-search channels.** A [Model Context Protocol](https://modelcontextprotocol.io) server that fronts a set of upstream web-search APIs behind a single `web_search` tool. Channels ship in different wire formats — some are OpenAI-compatible chat-completions with a server-side tool-call or fiber loop, others are standalone search REST endpoints — and this server normalizes all of them into one schema and gives you two strategies:

- **`fallback`** (default) — try channels in your priority order, return the first success. Few calls, low latency.
- **`aggregate`** — query several channels in parallel, merge results, dedupe by URL, and tag each item with its source. Wider coverage.

```
fallback:   kimi ──✓ 1.2s → return          aggregate:  kimi  ─┐
            stepfun (only if kimi failed)               stepfun ─┼─→ merge + dedupe → return
            zhipu   (only if the above failed)          zhipu   ─┘
```

The channel identifiers shown above (`kimi`, `stepfun`, `zhipu`, `mimo`) are the literal config keys — see [Configuration](#configuration) for the full set.

## Install

Requires Node >= 18. From a checkout:

```bash
npm install
npm run build     # tsc → dist/
```

Provide at least one channel API key — via environment variables, a `.env` file, or a JSON config file (see [Configuration](#configuration)). Channels without a key are skipped automatically.

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
cn-websearch-mcp status                # effective settings + channel status
cn-websearch-mcp test                  # probe every ready channel once
cn-websearch-mcp repl                  # interactive session
cn-websearch-mcp help                  # full usage
```

Options: `-n/--count <1-50>`, `--strategy fallback|aggregate`, `--providers a,b` (restrict this call), `--no-dedupe`, `-q/--query` (query for `test`), `--json` (raw output for scripting), `-h`, `-v`.

Exit codes: `0` success, `1` runtime failure (search failed / nothing configured), `2` usage error — so scripts and CI can branch on them.

In the interactive session, bare text is a search and `/` commands control the session:

```
cn-websearch> a recent news query
cn-websearch> /strategy aggregate      # switch this session to multi-source
cn-websearch> /aggregate rust async    # one-off multi-source search
cn-websearch> /count 12
cn-websearch> /providers stepfun,zhipu # restrict this session
cn-websearch> /test stepfun            # probe one channel
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
    "zhipu":   { "priority": 5, "options": { "searchEngine": "search_pro" } },
    "kimi":    { "enabled": false }
  }
}
```

If you put API keys in this file, **do not commit it** — `cn-websearch.config.json` is git-ignored by default for that reason (use `git add -f` if you keep a keyless, shareable config there).

### Choosing channel priority

Three equivalent ways, evaluated in this order:

1. `order` (config file) or `WEBSEARCH_ORDER` (env) — an explicit list, highest priority first: `["stepfun", "zhipu"]`.
2. `priority` per channel — a number, higher goes earlier. Ties are broken alphabetically so the result is deterministic.
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
| `order` | `WEBSEARCH_ORDER` | alphabetical | Explicit priority list |
| `count` | `WEBSEARCH_COUNT` | `8` | Default result count when a tool call omits `count` |
| `timeoutMs` | `WEBSEARCH_TIMEOUT_MS` | `30000` | Budget per attempt; a retry gets a fresh budget, so one channel's worst case is ~2× |
| `maxProviders` | `WEBSEARCH_MAX_PROVIDERS` | `4` | Cap on channels per call (chain length / fan-out) |
| `dedupe` | `WEBSEARCH_DEDUPE` | `true` | Merge duplicate URLs when aggregating |
| — | `WEBSEARCH_CONFIG` | — | Explicit config file path |

Booleans accept `true/false`, `1/0`, `yes/no`, `on/off`. Invalid values are ignored with a warning rather than failing.

### Per-channel settings

Every channel supports the same generic knobs, in the config file or as `<NAME>_<SUFFIX>` environment variables:

`apiKey` (`_API_KEY`), `baseUrl` (`_BASE_URL`), `model` (`_MODEL`), `enabled` (`_ENABLED`), `priority` (`_PRIORITY`), `timeoutMs` (`_TIMEOUT_MS`, overrides the global budget for that channel), and `options` for channel-specific parameters.

The four built-in channel slots and the `options` keys each one recognises:

| Slot | Channel type | Recognised `options` |
|---|---|---|
| `kimi`    | chat-completions with a multi-round tool-call loop and a separate fiber endpoint | `maxRounds` (1-5, default 2), `maxTokens` (256-32768, default 8192) |
| `mimo`    | chat-completions with a server-side `web_search` tool                     | `location` (object `{country, region, city}`; see below), `maxKeyword` (1-10, default 3), `forceSearch` (default `true`) |
| `stepfun` | standalone search REST endpoint (`POST {base}/v1/search`)                | `category` (omitted unless set) |
| `zhipu`   | standalone web-search API (`POST {base}/api/paas/v4/web_search`)         | `searchEngine` (default `search_std`), `contentSize` (default `high`); `searchEngine` is also readable from `ZHIPU_SEARCH_ENGINE` |

The `kimi` slot's multi-round loop caps at `maxRounds` tool-call rounds before forcing one final chat call (without tools) for the answer; `maxTokens` is the token budget per chat call. The `mimo` slot sends a server-side `web_search` tool with `maxKeyword` and `forceSearch` knobs and an approximate `user_location` assembled from the configured `location` keys (`country` is always sent and defaults to `China`; `region` and `city` only when explicitly configured). The `stepfun` and `zhipu` slots are direct REST calls — their options map one-to-one to documented request fields.

Keys are never logged or echoed: error text is scrubbed of credential-looking strings, and status output only reports whether a key is set.

## Tools

### `web_search`

Input: `{ "query": string, "count"?: integer, "strategy"?: "fallback"|"aggregate", "providers"?: string[] }`.

`count` defaults to your configured `count`, `strategy` to your configured strategy, and `providers` (when given) must name slots that are enabled and have a key — otherwise the call returns a structured error naming the problem rather than silently ignoring it.

Output: normalized results plus an audit trail. In aggregate mode each item carries `source`, and `_meta.providers` lists everyone who answered:

```json
{
  "results": [
    {
      "title": "…",
      "url": "https://…",
      "snippet": "…",
      "content": "optional full text when the channel returns it",
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
      { "provider": "zhipu",   "status": "transient_error", "latency_ms": 611, "error": "HttpError: HTTP 429: …" }
    ]
  }
}
```

### `provider_status`

Read-only: effective strategy and settings, and per slot whether it is enabled, has a key, and is in the active chain.

## Fallback & failure semantics

- Only channels that are enabled **and** have a key participate. `fallback` walks them in priority order; `aggregate` queries them in parallel.
- Per attempt: one wall-clock budget (`timeoutMs`); hung requests are aborted and recorded as `timeout`.
- Transient failures (network errors, HTTP 5xx, 429, timeout) are retried **once**, then the next channel is tried.
- Permanent failures (HTTP 4xx other than 429) skip the retry and move on immediately.
- In `aggregate`, partial failure is not failure: successful channels' results are returned and the failures stay in `_meta.attempts`.
- Every attempt is recorded in `_meta.attempts` — success, retry, timeout or error.
- If everyone fails, `web_search` returns a structured error containing the full attempt list.

## Channel matrix

| Slot | Wire channel | Structured fields | Body excerpt |
|---|---|---|---|
| `kimi`    | chat-completions + multi-round tool-call loop + `POST {base}/v1/formulas/moonshot/web-search:latest/fibers` | reference URLs from fiber | LLM answer in `_meta.answer` |
| `mimo`    | OpenAI-compatible chat-completions with a server-side `web_search` tool | `url_citation` + `web_search_highlight` annotations | LLM answer in `_meta.answer` |
| `stepfun` | `POST {base}/v1/search` | title, time, snippet, content | full text in `content` |
| `zhipu`   | `POST {base}/api/paas/v4/web_search` | title, link, content, publish_date | summary in `snippet`, full text in `content` |

Two slots (`kimi`, `mimo`) return an LLM-synthesized answer plus citations rather than a plain result list. This server surfaces the citations as result items and puts the synthesized answer in `_meta.answer` (labelled per channel when aggregating several).

## Development

```bash
npm install
npm run build          # tsc → dist/
npm test               # vitest, all HTTP mocked (no keys needed)
npm run test:coverage  # coverage gate: 95% minimum on src/ (lines/functions/branches/statements)
npm run smoke          # real requests against every ready channel, prints a latency table
npm run cli -- repl    # run the CLI from source via tsx
```

### Conventions

- **Comments and file headers are written in English.**
- **Runtime-visible strings stay in English** — tool descriptions, CLI output, log lines and error messages — so clients and scripts get stable, greppable output.
- `SERVER_NAME` / `SERVER_VERSION` in `src/server-info.ts` are the single source of truth for the server identity; `test/server-info.test.ts` asserts they match `package.json` on every test run.
- Layering is one-directional: `types` / `errors` / `config-file` / `normalize` at the bottom, then `config` / `http`, then `orchestrator` / `probe`, then `providers`, then `runtime` / `tools` / `cli`.

## Repository layout

| Path | Contents |
|---|---|
| [src/](src/README.md) | All runtime code (TypeScript, ESM) |
| [src/cli/](src/cli/README.md) | Terminal interface: argument parsing, one-shot commands, interactive session |
| [src/providers/](src/providers/README.md) | Per-channel adapters and the adapter registry |
| [test/](test/README.md) | Vitest suite: unit tests and subprocess end-to-end tests |
| [scripts/](scripts/README.md) | Live-network utilities (smoke probe, MCP stdio probe) |

Working rules for coding agents live in [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)