/**
 * @file probe
 * @description Single-provider probe: one live call plus a structured result row.
 *
 * Responsibilities:
 * - Call a single provider with an independent timeout, returning a data row on success or failure instead of throwing
 * - Provide one shared implementation for the CLI's `test` command and `npm run smoke`
 */

// Probe logic lives in its own module so the CLI and the smoke script don't
// each keep a copy (smoke.ts previously inlined this).

import { summarizeError } from "./errors.js";
import type { FetchLike, SearchProvider, SearchRequest } from "./types.js";

export interface ProbeOptions {
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

/** Probe result row for a single provider. */
export interface ProbeRow {
  provider: string;
  ok: boolean;
  latency_ms: number;
  results: number;
  /** Title of the first result (on success), for eyeballing whether the channel really works. */
  sample: string;
  /** Failure summary; empty string on success. */
  error: string;
}

/**
 * Probe one provider. Any failure (network, timeout, protocol, parsing) is
 * converted into a row with ok=false and never thrown — the whole point of a
 * probe is to find the broken provider.
 */
export async function probeProvider(
  p: SearchProvider,
  req: SearchRequest,
  opts: ProbeOptions,
): Promise<ProbeRow> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("probe timeout")), opts.timeoutMs);
  const t0 = Date.now();
  try {
    const out = await p.search(req, {
      timeoutMs: opts.timeoutMs,
      signal: ac.signal,
      fetchImpl: opts.fetchImpl ?? fetch,
    });
    return {
      provider: p.name,
      ok: true,
      latency_ms: Date.now() - t0,
      results: out.results.length,
      sample: out.results[0]?.title?.slice(0, 60) ?? "(no results)",
      error: "",
    };
  } catch (err) {
    return {
      provider: p.name,
      ok: false,
      latency_ms: Date.now() - t0,
      results: 0,
      sample: "",
      error: summarizeError(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe a group of providers sequentially (avoids saturating every upstream quota at once). */
export async function probeAll(
  providers: SearchProvider[],
  req: SearchRequest,
  opts: ProbeOptions,
): Promise<ProbeRow[]> {
  const rows: ProbeRow[] = [];
  for (const p of providers) {
    rows.push(await probeProvider(p, req, opts));
  }
  return rows;
}
