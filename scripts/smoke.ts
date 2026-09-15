/**
 * @file smoke
 * @description Live-network smoke probe that prints a latency comparison table.
 *
 * Responsibilities:
 * - Probe every available provider one by one with a fixed real query (reusing the probe module)
 * - Print markdown rows of each provider's status / latency / result count
 * - Run one full call under the configured strategy and report who answered
 */

// Live-network smoke test: probe each configured provider in turn, print a latency
// comparison table, then do one full run under the current strategy.
//
// Usage: npm run smoke (requires a key in env/.env or cn-websearch.config.json; never prints secrets)

import { loadDotEnv } from "../src/dotenv.js";
import { createRuntime } from "../src/runtime.js";
import { runSearch } from "../src/orchestrator.js";
import { probeAll, type ProbeRow } from "../src/probe.js";

const QUERY = process.env.SMOKE_QUERY || "最近一周国内发布的大模型";

/** Escapes vertical bars in table cells so the markdown table stays intact. */
function cell(s: string): string {
  return s.replace(/\|/g, "\\|");
}

async function main(): Promise<void> {
  loadDotEnv();
  const runtime = createRuntime();
  const { config, chain } = runtime;

  console.log(`# cn-websearch-mcp smoke — ${new Date().toISOString()}`);
  console.log(`query: "${QUERY}" (count=${config.count}), per-attempt timeout: ${config.timeoutMs}ms`);
  console.log(`strategy: ${config.strategy}`);
  console.log(`providers ready: ${chain.map((p) => p.name).join(", ") || "(none)"}`);
  if (!chain.length) {
    console.error("no provider API keys found; nothing to smoke");
    process.exit(1);
  }

  const rows: ProbeRow[] = await probeAll(
    chain,
    { query: QUERY, count: config.count },
    { timeoutMs: config.timeoutMs },
  );

  console.log("\n| provider | status | latency_ms | results | first result title |");
  console.log("|---|---|---|---|---|");
  for (const r of rows) {
    console.log(
      `| ${r.provider} | ${r.ok ? "ok" : "failed"} | ${r.latency_ms} | ${r.results} | ${cell(
        r.ok ? r.sample : r.error.slice(0, 60),
      )} |`,
    );
  }
  const failed = rows.filter((r) => !r.ok);
  if (failed.length) {
    console.log("\nfailure details:");
    for (const r of failed) console.log(`- ${r.provider}: ${r.error}`);
  }

  console.log(`\n## ${config.strategy} run`);
  const t0 = Date.now();
  try {
    const out = await runSearch(
      { query: QUERY, count: config.count },
      {
        providers: chain,
        timeoutMs: config.timeoutMs,
        maxProviders: config.maxProviders,
        dedupe: config.dedupe,
        strategy: config.strategy,
      },
    );
    const sources = out._meta.providers?.join(", ") ?? out._meta.provider;
    console.log(`answered by: ${sources} after ${Date.now() - t0}ms`);
    console.log(`attempts: ${JSON.stringify(out._meta.attempts)}`);
    console.log(`results: ${out.results.length}${out._meta.answer ? " (+answer)" : ""}`);
  } catch (err) {
    console.error(`run failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// CLI script: main already catches every failure path internally, so no unhandled rejection can escape here.
void main();
