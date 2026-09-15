/**
 * @file errors
 * @description Error taxonomy shared by the adapters and the orchestrator.
 *
 * Responsibilities:
 * - Provide typed failure categories: timeout, network, HTTP status, response shape parsing
 * - Classify a failure as transient (worth one retry) or permanent
 * - Compress any error into a short, non-sensitive summary string
 */

// Error taxonomy shared by the adapters and the orchestrator.

export class TimeoutError extends Error {
  constructor(message = "request timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

/** Transport-layer failure carrying an HTTP status code. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/**
 * Thrown when an upstream response cannot be parsed. Treated as a permanent
 * error: retrying a structurally broken response is usually pointless.
 */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

/** Whether the failure is worth one retry (network error / 5xx / 429 / timeout). */
export function isTransient(err: unknown): boolean {
  if (err instanceof TimeoutError || err instanceof NetworkError) return true;
  if (err instanceof HttpError) return err.status >= 500 || err.status === 429;
  return false;
}

/**
 * Text patterns that look like credentials. Upstreams sometimes echo their own
 * account identifiers or keys in error response bodies (Kimi's 429 responses,
 * for instance, carry ak-… and org-… identifiers). The audit trail flows to
 * MCP clients and the terminal, so such fragments must be redacted before use.
 *
 * \b word boundaries are deliberately avoided: error bodies often carry JSON
 * escapes (e.g. \u003c forms), which makes boundaries unreliable. The short
 * prefixes require a longer random body (12+ chars) to avoid matching ordinary
 * English words (e.g. peak-performance). Residual false positives only affect
 * wording, not safety — better to over-redact than to miss one.
 */
const SECRET_PATTERNS: RegExp[] = [
  // Keys shaped like sk-xxx / ak-xxx
  /(?:sk|ak|pk|rk)[-_][A-Za-z0-9._-]{12,}/gi,
  // Assignment-style keys like apikey=xxx / token: xxx / secret_xxx
  // (a following space is only allowed after an explicit separator, so plain
  // sentences like "the token was invalidated" are not caught)
  /(?:api[_-]?key|token|secret|password)(?:[-_:=]\s*)?[A-Za-z0-9._-]{8,}/gi,
  // Account / organization / user identifiers
  /(?:org|account|uid|user[_-]?id)-[A-Za-z0-9._-]{6,}/gi,
  // Authorization headers
  /Bearer\s+[A-Za-z0-9._-]{8,}/gi,
];

/** Redact fragments that look like credentials; keeps a 3-char prefix for debugging (e.g. ak-***). */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((acc, re) => acc.replace(re, (m) => `${m.slice(0, 3)}***`), text);
}

/** Collapse consecutive whitespace into single spaces, keeping the audit trail single-line readable. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Produce a short, key-free error summary for AttemptRecord.error.
 * In order: collapse whitespace → redact credential-like fragments → truncate to 300 chars.
 */
export function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    const msg = collapseWhitespace(redactSecrets(err.message));
    return `${err.name}: ${msg.length > 300 ? msg.slice(0, 300) + "..." : msg}`;
  }
  return collapseWhitespace(redactSecrets(String(err))).slice(0, 300);
}
