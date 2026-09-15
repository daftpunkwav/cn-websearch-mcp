/**
 * @file cli/render
 * @description CLI output rendering: results, status, probe table, and config redaction.
 *
 * Responsibilities:
 * - Render search results as human-readable text (or raw JSON)
 * - Render provider status and the probe table
 * - Redact API keys when printing config snapshots so no code path ever prints a secret
 */

// Rendering layer: only "data -> text"; no network or config parsing. All output touching
// secrets must go through redactedConfig or echo only "configured or not".

import type { GatewayConfig, ProviderName } from "../config.js";
import type { ProbeRow } from "../probe.js";
import type { NormalizedSearchResult } from "../types.js";
import { truncate } from "../normalize.js";

/** Snippet length cap for rendering: terminal readability first; full content remains available via --json. */
const SNIPPET_MAX = 160;

/** Secret redaction: echo only whether a key is set, never its contents. */
export function redactedConfig(config: GatewayConfig): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(config.providers)) {
    providers[name] = {
      enabled: p.enabled,
      priority: p.priority,
      baseUrl: p.baseUrl,
      model: p.model ?? null,
      apiKey: p.apiKey.trim() === "" ? "(unset)" : "(set)",
      timeoutMs: p.timeoutMs ?? null,
      options: p.options ?? null,
    };
  }
  return {
    strategy: config.strategy,
    order: config.order,
    timeoutMs: config.timeoutMs,
    count: config.count,
    maxProviders: config.maxProviders,
    dedupe: config.dedupe,
    configFile: config.configFile ?? null,
    providers,
  };
}

/** Formats one search result as human-readable text. */
export function formatSearchResult(out: NormalizedSearchResult): string {
  const meta = out._meta;
  const sources = meta.providers?.length ? meta.providers.join(", ") : meta.provider;
  const lines: string[] = [
    `answered by: ${sources}  (${meta.total_latency_ms}ms total, ${out.results.length} result(s))`,
    "",
  ];
  out.results.forEach((item, i) => {
    const source = item.source && meta.providers && meta.providers.length > 1 ? `  [${item.source}]` : "";
    lines.push(`${i + 1}. ${item.title || "(untitled)"}${source}`);
    lines.push(`   ${item.url}`);
    if (item.snippet) lines.push(`   ${truncate(item.snippet, SNIPPET_MAX)}`);
    if (item.published_date) lines.push(`   published: ${item.published_date}`);
  });
  if (meta.answer) {
    lines.push("", "synthesized answer:", meta.answer);
  }
  if (meta.attempts.length) {
    const trail = meta.attempts
      .map((a) => `${a.provider}:${a.status}(${a.latency_ms}ms)${a.error ? ` ${a.error}` : ""}`)
      .join(" | ");
    lines.push("", `attempts: ${trail}`);
  }
  return lines.join("\n");
}

/** Formats the effective config and provider status (redacted). */
export function formatStatus(config: GatewayConfig, chainNames: string[]): string {
  const inChain = new Set(chainNames);
  const lines: string[] = [
    `strategy      : ${config.strategy}`,
    `order         : ${config.order.join(" -> ") || "(none)"}`,
    `count (default): ${config.count}`,
    `timeout/attempt: ${config.timeoutMs}ms`,
    `max providers : ${config.maxProviders}`,
    `dedupe        : ${config.dedupe ? "on" : "off"}`,
    `config file   : ${config.configFile ?? "(none)"}`,
    "",
    "provider   enabled  configured  in-chain  priority  model",
  ];
  for (const name of Object.keys(config.providers) as ProviderName[]) {
    const p = config.providers[name];
    const cells = [
      name.padEnd(10),
      (p.enabled ? "yes" : "no").padEnd(8),
      (p.apiKey.trim() !== "" ? "yes" : "no").padEnd(11),
      (inChain.has(name) ? "yes" : "no").padEnd(9),
      String(p.priority).padEnd(9),
      p.model ?? "-",
    ];
    lines.push(cells.join(" "));
  }
  if (!chainNames.length) {
    lines.push("", "no provider is ready: set an API key (env or config file) to enable searching");
  }
  return lines.join("\n");
}

/** Formats the probe results table. */
export function formatProbeTable(rows: ProbeRow[]): string {
  const lines = ["provider   status  latency  results  note"];
  for (const r of rows) {
    lines.push(
      [
        r.provider.padEnd(10),
        (r.ok ? "ok" : "failed").padEnd(7),
        `${r.latency_ms}ms`.padEnd(8),
        String(r.results).padEnd(8),
        r.ok ? r.sample : truncate(r.error, 80),
      ].join(" "),
    );
  }
  return lines.join("\n");
}
