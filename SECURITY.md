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
  status output reports only whether a key is set.
- `.env` and `cn-websearch.config.json` (which may hold API keys) are
  git-ignored by default.
- The test suite never contacts real upstreams: all HTTP is mocked in unit
  tests, and the end-to-end helpers strip every credential variable before
  spawning a subprocess.
- Outbound traffic goes only to the configured channel `baseUrl` endpoints,
  over HTTPS, with a per-attempt timeout.
