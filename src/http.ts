/**
 * @file http
 * @description Shared JSON POST helper layer with unified timeout and abort handling.
 *
 * Responsibilities:
 * - Merge the caller's signal with the per-request timeout (Node 18-compatible implementation)
 * - Wrap transport failures as NetworkError / TimeoutError
 * - Throw HttpError uniformly for HTTP >= 400; never write credentials into logs or error messages
 */

// Lightweight HTTP helpers shared by all adapters: JSON POST with timeout and
// abort support, plus error classification. Credentials never reach logs or
// error messages.

import { HttpError, NetworkError, redactSecrets, TimeoutError } from "./errors.js";
import type { FetchLike } from "./types.js";

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
 * - Other fetch/body-read failures → NetworkError
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

async function readBody(res: Response, signal: AbortSignal, cancel: () => void): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    cancel();
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new TimeoutError();
    }
    throw new NetworkError(err instanceof Error ? err.message : String(err));
  }
}
