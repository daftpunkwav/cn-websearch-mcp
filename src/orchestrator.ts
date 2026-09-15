/**
 * @file orchestrator
 * @description Search orchestration: single-source fallback chain (fallback) and multi-source aggregation (aggregate).
 *
 * Responsibilities:
 * - Single entry point runSearch: dispatch to fallback or aggregate by strategy
 * - Enforce the wall-clock timeout budget for each attempt via an abort signal
 * - Retry transient failures once; assemble _meta (provider, latency, attempt audit) or a structured failure
 * - Under aggregate, query several providers in parallel, merge/dedupe by URL and tag sources
 */

// Orchestration layer: timeout circuit-breaking, at most one transient retry
// per provider, fallback and aggregation. Adapters stay thin; all cross-cutting
// concerns (timeout/retry/fallback/aggregate/audit) live here.

import { isTransient, summarizeError, TimeoutError } from "./errors.js";
import { mergeSourceItems } from "./normalize.js";
import type {
  AttemptRecord,
  AttemptStatus,
  FetchLike,
  NormalizedSearchResult,
  SearchProvider,
  SearchRequest,
  SearchStrategy,
} from "./types.js";

export class NoProviderConfiguredError extends Error {
  constructor() {
    super("no provider is configured: set at least one provider API key (see .env.example or cn-websearch.config.json)");
    this.name = "NoProviderConfiguredError";
  }
}

/** Thrown when every provider participating in the call fails; carries the full attempt audit trail. */
export class AllProvidersFailedError extends Error {
  readonly attempts: AttemptRecord[];
  constructor(attempts: AttemptRecord[]) {
    const detail = attempts
      .map((a) => `${a.provider}=${a.status}${a.error ? `(${a.error})` : ""}`)
      .join("; ");
    super(`all configured providers failed: ${detail}`);
    this.name = "AllProvidersFailedError";
    this.attempts = attempts;
  }
}

export interface OrchestratorOptions {
  /** Providers participating in this call, in priority order. */
  providers: SearchProvider[];
  /**
   * Wall-clock budget per attempt; a retry gets its own equal budget, so a
   * single provider's worst case is roughly 2 × timeoutMs (first try plus one
   * retry). A provider with its own configured budget uses that instead.
   */
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

export interface DispatchOptions extends OrchestratorOptions {
  strategy: SearchStrategy;
  /** Maximum number of providers used for this call (default: all). */
  maxProviders?: number;
  /** Under aggregate, whether to dedupe by URL (default true). */
  dedupe?: boolean;
}

/**
 * Run a single provider: at most two attempts (first try + one retry after a
 * transient failure). Hung calls are aborted when the budget runs out and
 * recorded as "timeout". Every attempt, including failed retries, ends up in
 * the returned audit records.
 *
 * This function is total: any exception thrown by the provider is caught and
 * converted into audit records, so callers can schedule it directly with
 * Promise.all (the aggregate strategy relies on this property).
 */
async function runProvider(
  p: SearchProvider,
  req: SearchRequest,
  opts: OrchestratorOptions,
): Promise<{ records: AttemptRecord[]; result?: NormalizedSearchResult }> {
  const records: AttemptRecord[] = [];
  const budget = p.timeoutMs && p.timeoutMs > 0 ? p.timeoutMs : opts.timeoutMs;
  // The only path that keeps looping is a transient failure on the first try,
  // so this iterates at most twice; every other path returns, so the loop terminates.
  for (let tryIndex = 0; ; tryIndex++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new TimeoutError()), budget);
    const t0 = Date.now();
    try {
      const result = await p.search(req, {
        timeoutMs: budget,
        signal: ac.signal,
        fetchImpl: opts.fetchImpl ?? fetch,
      });
      records.push({ provider: p.name, status: "ok", latency_ms: Date.now() - t0 });
      return { records, result };
    } catch (err) {
      const latency_ms = Date.now() - t0;
      // The timeout verdict comes from this layer's controller's abort reason:
      // only an abort raised here with a TimeoutError counts as "timeout";
      // timeout-like errors thrown by the adapter itself are still classified
      // by isTransient.
      const timedOut = ac.signal.aborted && ac.signal.reason instanceof TimeoutError;
      const status: AttemptStatus = timedOut
        ? "timeout"
        : isTransient(err)
          ? "transient_error"
          : "permanent_error";
      records.push({ provider: p.name, status, latency_ms, error: summarizeError(err) });
      // Transient failures retry once; any other failure abandons the provider immediately.
      if (status !== "transient_error" || tryIndex === 1) return { records };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Single-source fallback: walk in order and return the first successful
 * result; throw AllProvidersFailedError (with the full audit trail) when all
 * fail. Throw NoProviderConfiguredError when the chain is empty.
 */
export async function searchWithFallback(req: SearchRequest, opts: OrchestratorOptions): Promise<NormalizedSearchResult> {
  if (!opts.providers.length) throw new NoProviderConfiguredError();
  const t0 = Date.now();
  const attempts: AttemptRecord[] = [];
  for (const p of opts.providers) {
    const { records, result } = await runProvider(p, req, opts);
    attempts.push(...records);
    const ok = records[records.length - 1];
    if (ok && ok.status === "ok" && result) {
      return {
        results: result.results,
        _meta: {
          provider: result._meta.provider,
          providers: [result._meta.provider],
          total_latency_ms: Date.now() - t0,
          attempts,
          answer: result._meta.answer,
        },
      };
    }
  }
  throw new AllProvidersFailedError(attempts);
}

/** Join several providers' LLM-synthesized answers into one readable text (returned as-is for a single source). */
function joinAnswers(answered: Array<{ provider: string; answer?: string }>): string {
  const parts = answered
    .map((a) => ({ provider: a.provider, answer: (a.answer ?? "").trim() }))
    .filter((a) => a.answer !== "");
  if (!parts.length) return "";
  if (parts.length === 1) return parts[0]!.answer;
  return parts.map((a) => `[${a.provider}] ${a.answer}`).join("\n\n");
}

/**
 * Multi-source aggregation: query all providers in parallel and merge results.
 * - Partial failure is not failure: successful providers' results are returned, failure details stay in _meta.attempts
 * - All failing throws AllProvidersFailedError
 * - Results are deduplicated by URL (configurable) and tagged with their source provider
 */
export async function searchAggregate(
  req: SearchRequest,
  opts: OrchestratorOptions & { dedupe?: boolean },
): Promise<NormalizedSearchResult> {
  if (!opts.providers.length) throw new NoProviderConfiguredError();
  const t0 = Date.now();
  // runProvider is total (absorbs all exceptions internally), so parallel scheduling is safe.
  const outcomes = await Promise.all(opts.providers.map((p) => runProvider(p, req, opts)));
  const attempts = outcomes.flatMap((o) => o.records);
  const answered = outcomes.flatMap((o) => (o.result ? [o.result] : []));
  if (!answered.length) throw new AllProvidersFailedError(attempts);

  const providers = answered.map((r) => r._meta.provider);
  const results = mergeSourceItems(
    answered.map((r) => ({ provider: r._meta.provider, items: r.results })),
    opts.dedupe ?? true,
  ).slice(0, req.count);

  return {
    results,
    _meta: {
      provider: providers[0]!,
      providers,
      total_latency_ms: Date.now() - t0,
      attempts,
      answer: joinAnswers(answered.map((r) => ({ provider: r._meta.provider, answer: r._meta.answer }))) || undefined,
    },
  };
}

/**
 * Unified search entry point: dispatch by strategy and apply the unified cap
 * on participating providers. This is the only orchestration function the
 * tool layer and the CLI need to call.
 */
export async function runSearch(req: SearchRequest, opts: DispatchOptions): Promise<NormalizedSearchResult> {
  const max = Math.max(1, opts.maxProviders ?? opts.providers.length);
  const providers = opts.providers.slice(0, max);
  if (!providers.length) throw new NoProviderConfiguredError();
  const scoped: OrchestratorOptions = { providers, timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl };
  return opts.strategy === "aggregate"
    ? searchAggregate(req, { ...scoped, dedupe: opts.dedupe })
    : searchWithFallback(req, scoped);
}
