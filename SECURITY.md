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
  assembled from already-redacted attempt text. The only unprocessed output is
  the top-level fatal handlers (`src/index.ts`, `src/cli/index.ts`), which
  print the underlying error to stderr for the local operator.
- `.env` and `cn-websearch.config.json` (which may hold API keys) are
  git-ignored by default.
- The test suite never contacts real upstreams: all HTTP is mocked in unit
  tests, and the end-to-end helpers build an env map from scratch that forwards
  only what node needs to start, so no credential reaches a subprocess.
- Outbound traffic goes only to the configured channel `baseUrl` endpoints,
  with a per-attempt timeout and a hard cap on how much of a response body is
  buffered. The scheme is whatever the configuration says: a non-`https`
  `baseUrl` is **not blocked**, but it is reported with a startup warning
  because the `Authorization` header — and therefore the key — would travel in
  cleartext. Keep the default `https` endpoints, or point a slot at a
  loopback proxy.
- Upstream text (titles, snippets, URLs) is stripped of control characters
  before it reaches a caller, so a hostile response cannot repaint or forge
  terminal output.
- No credential-looking text is taken from the wire and reflected back: an
  abort reason supplied by the MCP client is replaced with a fixed message.
