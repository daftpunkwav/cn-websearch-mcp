/**
 * @file http
 * @description Shared JSON POST helper layer with unified timeout and abort handling.
 *
 * Responsibilities:
 * - Merge the caller's signal with the per-request timeout (Node 18-compatible implementation)
 * - Bound how much of a response body is buffered before giving up
 * - Wrap transport failures as NetworkError / TimeoutError
 * - Throw HttpError uniformly for HTTP >= 400; never write credentials into logs or error messages
 */

// Lightweight HTTP helpers shared by all adapters: JSON POST with timeout and
// abort support, plus error classification. Credentials never reach logs or
// error messages.

import { HttpError, NetworkError, ParseError, redactSecrets, TimeoutError } from "./errors.js";
import type { FetchLike } from "./types.js";

/**
 * Hard cap on a single response body. Upstream payloads are small JSON
 * documents; anything past this is a broken or hostile endpoint, and buffering
 * it would let one response exhaust the process heap. Exceeding it is reported
 * as a ParseError, i.e. a permanent failure: retrying an oversized body would
 * only repeat the download.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface HttpOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl: FetchLike;
}

export interface HttpResponse {
  status: number;
  text: string;
  /** Parsed JSON body; null when the body is not valid JSON. */
  json: unknown;
}

/**
 * Merge the caller-provided signal with the per-request timeout into one signal.
 * AbortSignal.any is a Node 20+ API; merged manually for Node 18 compatibility.
 */
function combinedSignal(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new TimeoutError()), timeoutMs);
  const onAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) onAbort();
    else external.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Send a JSON POST and read the response. Error semantics:
 * - Timeout (internal timer) → TimeoutError
 * - External abort → the abort reason propagates as-is; non-Error reasons fall back to TimeoutError
 * - A body that finishes reading after the signal aborted → the abort reason, never a late success
 * - Other fetch/body-read failures → NetworkError
 * - A body larger than the internal cap → ParseError (permanent: retrying it would just re-download)
 * - HTTP >= 400 → HttpError (message truncated to the first 300 chars, guarding against giant bodies)
 * - 2xx with a non-JSON body → json is null; the upper layer's asObject normalizes it to ParseError
 */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  opts: HttpOptions,
): Promise<HttpResponse> {
  const { signal, cancel } = combinedSignal(opts.timeoutMs, opts.signal);
  let res: Response;
  try {
    res = await opts.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    cancel();
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new TimeoutError();
    }
    throw new NetworkError(err instanceof Error ? err.message : String(err));
  }
  const text = await readBody(res, signal, cancel);
  cancel();
  // A body that only landed after the budget expired is not a result: without
  // this check an injected fetch that ignores the signal, or a response that
  // finishes streaming exactly on the boundary, would be reported as a success.
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new TimeoutError();
  }
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (res.status >= 400) {
    // Upstream error bodies may echo account/key identifiers; redact before they reach the message.
    throw new HttpError(res.status, `HTTP ${res.status}: ${redactSecrets(text.slice(0, 300))}`);
  }
  return { status: res.status, text, json };
}

/**
 * Read the response body as text, refusing to buffer more than MAX_BODY_BYTES.
 *
 * Streaming (chunk-counting) is used whenever the response exposes a real
 * `body` stream; a Response-shaped object without one (test doubles) falls back
 * to `text()` and is then bounded only by the Content-Length pre-check.
 */
async function readBody(res: Response, signal: AbortSignal, cancel: () => void): Promise<string> {
  try {
    return await readText(res);
  } catch (err) {
    cancel();
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new TimeoutError();
    }
    throw err instanceof ParseError ? err : new NetworkError(err instanceof Error ? err.message : String(err));
  }
}

async function readText(res: Response): Promise<string> {
  const declared = Number(res.headers?.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    // Release the connection: an unconsumed body keeps the socket busy.
    await res.body?.cancel().catch(() => undefined);
    throw new ParseError(`response body too large: ${declared} bytes exceeds the ${MAX_BODY_BYTES} byte limit`);
  }
  if (!res.body?.getReader) return await res.text();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value?.byteLength ?? 0;
    if (received > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new ParseError(`response body too large: over the ${MAX_BODY_BYTES} byte limit`);
    }
    if (value) chunks.push(value);
  }
  // Match Response.text(): strip a leading UTF-8 BOM so a BOM'd JSON body still parses.
  const text = Buffer.concat(chunks).toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
