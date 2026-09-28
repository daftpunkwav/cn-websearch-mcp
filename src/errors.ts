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
 * Thrown when an upstream response cannot be used: it is not valid JSON, or it
 * is refused before parsing for being implausibly large. Treated as a permanent
 * error — retrying would only fetch the same unusable response again.
 */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

/**
 * Hard cap on the characters of one untrusted error text that may reach a
 * caller, applied both where an upstream body is folded into an HttpError
 * message and where summarizeError compresses any error for the audit trail.
 * One constant for both: if the two limits ever drifted, widening one would
 * leave the other cutting a credential in half.
 */
export const ERROR_MESSAGE_MAX = 300;

/**
 * Whether the failure is worth one retry (network error / 5xx / 429).
 *
 * A timeout is deliberately NOT transient. Its wall-clock budget is spent, so a
 * retry hands the same exhausted budget to the same channel and the documented
 * worst case per channel would silently grow from 2 × timeoutMs + backoff to
 * 3 ×. The verdict must also not depend on who noticed the timeout first: the
 * orchestrator's own budget timer and an adapter raising TimeoutError describe
 * the same dead request, so both are reported as "timeout" and neither retries.
 */
export function isTransient(err: unknown): boolean {
  if (err instanceof NetworkError) return true;
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

/**
 * Control characters that must never reach a caller: C0 except the newline that
 * multi-line LLM answers legitimately contain, plus DEL and the C1 block.
 * Untrusted text that ends up in a terminal — an upstream error body carried by
 * HttpError, an item title, a synthesized answer — can carry an escape sequence
 * that repaints or forges output lines, so it is removed at every chokepoint
 * before the text is shown. normalize.ts re-exports this helper for result items.
 */
const CONTROL_CHARS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;

/** Remove control characters from untrusted text. */
export function stripControlChars(s: string): string {
  return s.replace(CONTROL_CHARS, "");
}

/** Collapse consecutive whitespace into single spaces, keeping the audit trail single-line readable. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Produce a short, key-free error summary for AttemptRecord.error.
 * In order: strip control characters → redact credential-like fragments →
 * collapse whitespace → truncate to ERROR_MESSAGE_MAX chars. Each step must
 * precede the next: stripping first lets redaction match a credential split by a
 * control character, and redacting before truncating means a value cut in half
 * by the length limit is never emitted as a recognizable fragment.
 */
export function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    const msg = collapseWhitespace(redactSecrets(stripControlChars(err.message)));
    return `${err.name}: ${truncateForAudit(msg)}`;
  }
  return truncateForAudit(collapseWhitespace(redactSecrets(stripControlChars(String(err)))));
}

/** Cut already-sanitized text at the shared audit-trail limit, marking the cut. */
function truncateForAudit(text: string): string {
  return text.length > ERROR_MESSAGE_MAX ? text.slice(0, ERROR_MESSAGE_MAX) + "..." : text;
}
