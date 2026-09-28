# Security Policy

## Supported versions

Only the latest release on the `main` branch receives security fixes. This
project is pre-1.0; there are no long-term support lines.

## Reporting a vulnerability

Please report vulnerabilities privately rather than opening a public issue:

- Use [GitHub private vulnerability reporting](https://github.com/daftpunkwav/cn-websearch-mcp/security/advisories/new), or
- open a public issue **without** including any secret or exploit detail, and
  ask to be contacted privately.

You can expect an acknowledgement within a few days.

## Security design notes

- API keys are never logged, echoed, or written into error messages
  (`redactSecrets` in `src/errors.ts`, `redactedConfig` in `src/cli/render.ts`);
  status output reports only whether a key is set. Every error **returned to a
  caller** — the audit trail, the tool result, the terminal — is either passed
  through `summarizeError`, which redacts, or is a self-authored message
  assembled from already-redacted attempt text. Redaction always runs on the
  whole string and truncation happens after it, so a value cut in half by a
  length limit is never emitted as a recognizable fragment. The only
  unprocessed output is the top-level fatal handlers (`src/index.ts`,
  `src/cli/index.ts`), which print the underlying error to stderr for the local
  operator.
- A `.env` file is data from the working directory, which is not necessarily
  trusted — any repository can ship one. Only the names the gateway actually
  reads (`WEBSEARCH_*`, `ZHIPU_SEARCH_ENGINE`, and each slot's documented
  suffixes) are exported to `process.env`; everything else is dropped, so such
  a file cannot set `NODE_OPTIONS`, `LD_PRELOAD` or any other variable the Node
  runtime acts on before the first request.
- `.env` and `cn-websearch.config.json` (which may hold API keys) are
  git-ignored by default.
- The test suite never contacts real upstreams: all HTTP is mocked in unit
  tests, and the end-to-end helpers build an env map from scratch that forwards
  only what node needs to start, so no credential reaches a subprocess.
- Outbound traffic goes only to the configured channel `baseUrl` endpoints,
  with a per-attempt timeout and a hard cap on how much of a response body is
  buffered: the cap is counted chunk by chunk while the body streams and the
  connection is dropped the moment it is passed. Node's own `fetch` always
  exposes that stream. The one fallback — a Response-shaped object with no body
  stream at all, which in practice means a test double — can only be measured
  after `text()` has buffered it, so it still refuses to hand back an oversized
  body but cannot fail early. The scheme is whatever the configuration says: a
  non-`https` `baseUrl` is **not blocked**, but it is reported with a startup
  warning because the `Authorization` header — and therefore the key — would
  travel in cleartext. Keep the default `https` endpoints, or point a slot at a
  loopback proxy.
- Upstream text (titles, snippets, URLs, error bodies carried into the audit
  trail) is stripped of control characters before it reaches a caller, so a
  hostile response cannot repaint or forge terminal output.
- A result URL is only emitted as an `http`/`https` link. A reference that
  resolves to `javascript:`, `data:` or any other scheme is dropped: clients
  render these URLs as live links, and a search result has no legitimate use
  for one. The check reads the parsed protocol, not the raw prefix, so a scheme
  hidden behind a stripped tab or newline is caught too.
- No credential-looking text is taken from the wire and reflected back: an
  abort reason supplied by the MCP client is replaced with a fixed message.
