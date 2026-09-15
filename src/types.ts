/**
 * @file types
 * @description Shared type contracts for the gateway (pure type module, no runtime logic).
 *
 * Responsibilities:
 * - Define the normalized search result shape, per-attempt audit records, and merged multi-source metadata
 * - Define the search strategies, the search adapter interface, and the injectable search context
 * - Depend on no internal module itself; shared by the HTTP, normalization, orchestration, adapter and tool layers
 */

// Core types shared across the gateway.

/** Injectable fetch implementation so tests can mock HTTP without real keys. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Search strategies:
 * - `fallback`: try providers in priority order, return on the first success (fewer calls, lower latency)
 * - `aggregate`: query several providers in parallel, merge and dedupe for broader coverage
 */
export type SearchStrategy = "fallback" | "aggregate";

export interface SearchRequest {
  query: string;
  /** Desired result count, normalized by the tool layer; defaults from configuration. */
  count: number;
}

export interface NormalizedItem {
  title: string;
  url: string;
  snippet: string;
  /** Body excerpt when the provider returns full text. */
  content?: string;
  published_date?: string;
  /** Provider that supplied this item; filled by the orchestrator only in aggregate mode. */
  source?: string;
}

export type AttemptStatus = "ok" | "timeout" | "transient_error" | "permanent_error";

/** One row of the audit trail of a web_search call. */
export interface AttemptRecord {
  provider: string;
  status: AttemptStatus;
  latency_ms: number;
  /** Error summary. Must never contain keys or other sensitive material. */
  error?: string;
}

export interface ResultMeta {
  /** The first (highest-priority) provider that answered successfully. */
  provider: string;
  /** All providers that answered successfully; one item for single-source, several under aggregate. */
  providers?: string[];
  total_latency_ms: number;
  attempts: AttemptRecord[];
  /** Answer text when the provider works by LLM synthesis (kimi, mimo). */
  answer?: string;
}

export interface NormalizedSearchResult {
  results: NormalizedItem[];
  _meta: ResultMeta;
}

export interface SearchContext {
  /**
   * Wall-clock budget for a single search attempt, enforced by the orchestrator
   * through an abort signal. Note: a retry gets its own equal budget, and
   * adapters (e.g. kimi's multi-round HTTP calls) also use it as the
   * per-HTTP-request timeout cap.
   */
  timeoutMs: number;
  /** Aborted when the budget is exhausted or the caller's deadline passes. */
  signal: AbortSignal;
  fetchImpl: FetchLike;
}

export interface SearchProvider {
  readonly name: string;
  /** Per-provider timeout budget (ms); falls back to the global budget when unset. */
  readonly timeoutMs?: number;
  /** Whether the required API key exists in the environment. */
  isConfigured(): boolean;
  /**
   * Perform one logical search. Implementations must stay thin: request
   * construction and response parsing only; timeout, retry and fallback
   * are always the orchestrator's job. The returned _meta must carry
   * provider (and answer, where applicable); attempts and total_latency_ms
   * are filled in by the orchestrator.
   */
  search(req: SearchRequest, ctx: SearchContext): Promise<NormalizedSearchResult>;
}
