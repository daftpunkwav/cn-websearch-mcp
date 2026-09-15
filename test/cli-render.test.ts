/**
 * @file test/cli-render
 * @description CLI rendering unit tests: result/status/probe table formatting and config redaction.
 */

import { describe, expect, it } from "vitest";
import { formatProbeTable, formatSearchResult, formatStatus, redactedConfig } from "../src/cli/render.js";
import { loadConfig } from "../src/config.js";
import type { NormalizedSearchResult } from "../src/types.js";

function result(over: Partial<NormalizedSearchResult["_meta"]> = {}): NormalizedSearchResult {
  return {
    results: [
      { title: "Title A", url: "https://a.example/1", snippet: "Snippet A", published_date: "2026-01-01", source: "kimi" },
    ],
    _meta: {
      provider: "kimi",
      providers: ["kimi", "zhipu"],
      total_latency_ms: 1234,
      attempts: [{ provider: "kimi", status: "ok", latency_ms: 1200 }],
      ...over,
    },
  };
}

describe("redactedConfig", () => {
  it("never exposes an API key value, only its presence", () => {
    const cfg = loadConfig({
      env: { KIMI_API_KEY: "super-secret-key-value", ZHIPU_API_KEY: "" },
      warn: () => {},
      configFile: "/cfg.json",
    });
    const text = JSON.stringify(redactedConfig(cfg));
    expect(text).not.toContain("super-secret-key-value");
    expect(text).toContain('"(set)"');
    expect(text).toContain('"(unset)"');
  });

  it("includes the effective settings and per-provider fields", () => {
    const cfg = loadConfig({ env: {}, warn: () => {}, file: { strategy: "aggregate", count: 5 } });
    const snapshot = redactedConfig(cfg) as any;
    expect(snapshot).toMatchObject({ strategy: "aggregate", count: 5, dedupe: true, configFile: null });
    expect(snapshot.providers.kimi).toMatchObject({ enabled: true, priority: 0, apiKey: "(unset)" });
  });
});

describe("formatSearchResult", () => {
  it("lists results with numbering, urls, metadata and the attempt trail", () => {
    const text = formatSearchResult(result());
    expect(text).toContain("answered by: kimi, zhipu");
    expect(text).toContain("1234ms total, 1 result(s)");
    expect(text).toContain("1. Title A  [kimi]");
    expect(text).toContain("https://a.example/1");
    expect(text).toContain("published: 2026-01-01");
    expect(text).toContain("attempts: kimi:ok(1200ms)");
  });

  it("omits the per-item source tag and the sources list in single-provider mode", () => {
    const text = formatSearchResult(result({ providers: ["kimi"] }));
    expect(text).toContain("answered by: kimi");
    expect(text).not.toContain("[kimi]");
  });

  it("falls back to _meta.provider when providers is absent, and handles missing fields", () => {
    const text = formatSearchResult({
      results: [{ title: "", url: "https://x.example", snippet: "" }],
      _meta: { provider: "kimi", total_latency_ms: 5, attempts: [] },
    });
    expect(text).toContain("answered by: kimi");
    expect(text).toContain("(untitled)");
    expect(text).not.toContain("attempts:");
  });

  it("truncates long snippets and includes synthesized answers", () => {
    const text = formatSearchResult({
      results: [{ title: "t", url: "https://x.example", snippet: "s".repeat(300) }],
      _meta: { provider: "mimo", total_latency_ms: 1, attempts: [], answer: "the answer" },
    });
    expect(text).toContain("s".repeat(160));
    expect(text).not.toContain("s".repeat(161));
    expect(text).toContain("synthesized answer:\nthe answer");
  });
});

describe("formatStatus", () => {
  it("shows settings and a provider table, and flags an empty chain", () => {
    const cfg = loadConfig({ env: { KIMI_API_KEY: "k" }, warn: () => {} });
    const text = formatStatus(cfg, ["kimi"]);
    expect(text).toContain("strategy      : fallback");
    expect(text).toContain("order         : kimi -> mimo -> stepfun -> zhipu");
    expect(text).toContain("kimi");
    expect(text).toContain("config file   : (none)");
    expect(text).not.toContain("no provider is ready");

    const empty = formatStatus(cfg, []);
    expect(empty).toContain("no provider is ready");
  });
});

describe("formatProbeTable", () => {
  it("renders one row per provider with status, latency and note", () => {
    const text = formatProbeTable([
      { provider: "kimi", ok: true, latency_ms: 100, results: 3, sample: "Title", error: "" },
      { provider: "zhipu", ok: false, latency_ms: 200, results: 0, sample: "", error: "HttpError: 401" },
    ]);
    expect(text).toContain("provider   status  latency  results  note");
    expect(text).toContain("kimi");
    expect(text).toContain("Title");
    expect(text).toContain("zhipu");
    expect(text).toContain("failed");
    expect(text).toContain("HttpError: 401");
  });

  it("truncates long failure notes", () => {
    const text = formatProbeTable([
      { provider: "kimi", ok: false, latency_ms: 1, results: 0, sample: "", error: "e".repeat(200) },
    ]);
    expect(text).toContain("e".repeat(80));
    expect(text).not.toContain("e".repeat(81));
  });
});
