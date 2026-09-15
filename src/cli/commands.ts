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

import type { GatewayConfig } from "../config.js";
import { AllProvidersFailedError, NoProviderConfiguredError, runSearch } from "../orchestrator.js";
import { probeAll, type ProbeRow } from "../probe.js";
import { summarizeError } from "../errors.js";
import { formatProbeTable, formatSearchResult, formatStatus, redactedConfig } from "./render.js";
import type { CliArgs } from "./args.js";
import type { SearchProvider, SearchStrategy } from "../types.js";
import type { GatewayRuntime } from "../runtime.js";
import { KNOWN_PROVIDERS } from "../config.js";

/** CLI dependencies: runtime + output streams + injectable search/probe implementations (for tests). */
export interface CliDeps {
  runtime: GatewayRuntime;
  output: NodeJS.WritableStream;
  error: NodeJS.WritableStream;
  search?: typeof runSearch;
  probe?: typeof probeAll;
}

/** Default probe query for the `test` command: generic and non-personalized. */
export const DEFAULT_PROBE_QUERY = "今日新闻";

function write(stream: NodeJS.WritableStream, text: string): void {
  stream.write(text.endsWith("\n") ? text : text + "\n");
}

/** Filters out usable adapters by name; returns an error message or the selected list. */
export function pickProviders(
  names: string[] | undefined,
  chain: SearchProvider[],
): { ok: true; providers: SearchProvider[] } | { ok: false; error: string } {
  if (!names || !names.length) return { ok: true, providers: chain };
  const unknown = names.filter((n) => !(KNOWN_PROVIDERS as readonly string[]).includes(n));
  if (unknown.length) {
    return { ok: false, error: `unknown provider(s): ${unknown.join(", ")} (known: ${KNOWN_PROVIDERS.join(", ")})` };
  }
  const byName = new Map(chain.map((p) => [p.name, p]));
  const unavailable = names.filter((n) => !byName.has(n));
  if (unavailable.length) {
    return { ok: false, error: `provider(s) unavailable: ${unavailable.join(", ")} (disabled or missing API key)` };
  }
  return { ok: true, providers: names.map((n) => byName.get(n)!) };
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
  try {
    const out = await search(
      { query: args.query, count: args.count ?? config.count },
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
    if (err instanceof AllProvidersFailedError) {
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
  const rows: ProbeRow[] = await probe(
    picked.providers,
    { query: args.query || DEFAULT_PROBE_QUERY, count: args.count ?? runtime.config.count },
    { timeoutMs: runtime.config.timeoutMs },
  );
  write(output, args.json ? JSON.stringify(rows, null, 2) : formatProbeTable(rows));
  return rows.every((r) => r.ok) ? 0 : 1;
}
