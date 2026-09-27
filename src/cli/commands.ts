/**
 * @file cli/commands
 * @description One-shot CLI command implementations: search / status / test.
 *
 * Responsibilities:
 * - Overlay parsed arguments onto the config and call the orchestration layer to run the search
 * - Print results or structured errors; express success/failure via exit codes (handy for scripts and CI)
 * - All output goes through the injected io, so tests can assert on it without polluting process globals
 */

// One-shot commands. Exit code convention: 0 success; 1 runtime failure (search failed / no usable
// provider); 2 usage error (returned by the entry point when parsing fails).

import { COUNT_MAX, COUNT_MIN, QUERY_MAX, type GatewayConfig } from "../config.js";
import {
  AllProvidersFailedError,
  CallCancelledError,
  NoProviderConfiguredError,
  runSearch,
  type DispatchOptions,
} from "../orchestrator.js";
import { probeAll, type ProbeOptions, type ProbeRow } from "../probe.js";
import { selectProviders } from "../provider-selection.js";
import { summarizeError } from "../errors.js";
import { clampInt, truncate } from "../normalize.js";
import { formatProbeTable, formatSearchResult, formatStatus, redactedConfig } from "./render.js";
import type { CliArgs } from "./args.js";
import type { NormalizedSearchResult, SearchProvider, SearchRequest, SearchStrategy } from "../types.js";
import type { GatewayRuntime } from "../runtime.js";

/** Search implementation used by cmdSearch; injectable so tests never need the network. */
export type CliSearchFn = (req: SearchRequest, opts: DispatchOptions) => Promise<NormalizedSearchResult>;

/** Probe implementation used by cmdTest; injectable so tests never need the network. */
export type CliProbeFn = (
  providers: SearchProvider[],
  req: SearchRequest,
  opts: ProbeOptions,
) => Promise<ProbeRow[]>;

/** CLI dependencies: runtime + output streams + injectable search/probe implementations (for tests). */
export interface CliDeps {
  runtime: GatewayRuntime;
  output: NodeJS.WritableStream;
  error: NodeJS.WritableStream;
  search?: CliSearchFn;
  probe?: CliProbeFn;
}

/** Default probe query for the `test` command: generic and non-personalized. */
export const DEFAULT_PROBE_QUERY = "今日新闻";

function write(stream: NodeJS.WritableStream, text: string): void {
  stream.write(text.endsWith("\n") ? text : text + "\n");
}

/**
 * Restrict the call to the named providers, using the same name rules as the MCP
 * tool layer. An absent or empty list means "no filter": the CLI already rejects
 * an empty --providers at parse time, so this only covers a direct caller.
 */
export function pickProviders(
  names: string[] | undefined,
  chain: SearchProvider[],
): { ok: true; providers: SearchProvider[] } | { ok: false; error: string } {
  if (!names?.length) return { ok: true, providers: chain };
  return selectProviders(names, chain);
}

/**
 * Run one search and print it. Precedence for strategy/dedupe/count is
 * command-line arguments > config file/env vars.
 */
export async function cmdSearch(deps: CliDeps, args: CliArgs): Promise<number> {
  const { runtime, output, error } = deps;
  const config: GatewayConfig = runtime.config;
  if (!args.query.trim()) {
    write(error, "error: missing query (usage: cn-websearch-mcp search <query>)");
    return 2;
  }
  if (!runtime.chain.length) {
    write(error, "error: no provider is ready — set an API key via env or a config file, then retry");
    return 1;
  }
  const picked = pickProviders(args.providers, runtime.chain);
  if (!picked.ok) {
    write(error, `error: ${picked.error}`);
    return 2;
  }

  const search = deps.search ?? runSearch;
  const strategy: SearchStrategy = args.strategy ?? config.strategy;
  // Same argument contract as the MCP tool layer: a count is clamped to the
  // documented range and a query is capped, so both surfaces search alike.
  const count = args.count === undefined ? config.count : clampInt(args.count, config.count, COUNT_MIN, COUNT_MAX);
  const query = truncate(args.query.trim(), QUERY_MAX);
  try {
    const out = await search(
      { query, count },
      {
        providers: picked.providers,
        timeoutMs: config.timeoutMs,
        maxProviders: config.maxProviders,
        dedupe: args.dedupe ?? config.dedupe,
        strategy,
      },
    );
    write(output, args.json ? JSON.stringify(out, null, 2) : formatSearchResult(out));
    return 0;
  } catch (err) {
    // Both structured failures carry an audit trail; print it the same way
    // instead of special-casing each one.
    if (err instanceof AllProvidersFailedError || err instanceof CallCancelledError) {
      write(error, `error: ${err.message}`);
      for (const a of err.attempts) {
        write(error, `  - ${a.provider}: ${a.status} (${a.latency_ms}ms)${a.error ? ` ${a.error}` : ""}`);
      }
      return 1;
    }
    if (err instanceof NoProviderConfiguredError) {
      write(error, `error: ${err.message}`);
      return 1;
    }
    write(error, `error: unexpected failure: ${summarizeError(err)}`);
    return 1;
  }
}

/** Prints the effective config and provider status. */
export async function cmdStatus(deps: CliDeps, args: CliArgs): Promise<number> {
  const { runtime, output } = deps;
  const payload = args.json
    ? JSON.stringify(redactedConfig(runtime.config), null, 2)
    : formatStatus(runtime.config, runtime.chain.map((p) => p.name));
  write(output, payload);
  return 0;
}

/**
 * Probe providers one by one (real network calls). Returns exit code 1 if any provider fails,
 * so scripts can tell whether all channels are healthy.
 */
export async function cmdTest(deps: CliDeps, args: CliArgs): Promise<number> {
  const { runtime, output, error } = deps;
  if (!runtime.chain.length) {
    write(error, "error: no provider is ready — set an API key via env or a config file, then retry");
    return 1;
  }
  const picked = pickProviders(args.providers, runtime.chain);
  if (!picked.ok) {
    write(error, `error: ${picked.error}`);
    return 2;
  }

  const probe = deps.probe ?? probeAll;
  // Same argument bounds as `search` and the MCP tool layer, so a probe is sent
  // the same shape of request whichever surface asks for it.
  const rows: ProbeRow[] = await probe(
    picked.providers,
    {
      query: truncate(args.query || DEFAULT_PROBE_QUERY, QUERY_MAX),
      count: args.count === undefined
        ? runtime.config.count
        : clampInt(args.count, runtime.config.count, COUNT_MIN, COUNT_MAX),
    },
    { timeoutMs: runtime.config.timeoutMs },
  );
  write(output, args.json ? JSON.stringify(rows, null, 2) : formatProbeTable(rows));
  return rows.every((r) => r.ok) ? 0 : 1;
}
