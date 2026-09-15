/**
 * @file test/probe
 * @description Probe module unit tests: success/failure/timeout all produce data rows, sequential probing preserves input order.
 */

import { describe, expect, it } from "vitest";
import { probeAll, probeProvider } from "../src/probe.js";
import type { NormalizedSearchResult, SearchContext, SearchProvider, SearchRequest } from "../src/types.js";

const req: SearchRequest = { query: "q", count: 3 };

function provider(
  name: string,
  behavior: (r: SearchRequest, ctx: SearchContext) => Promise<NormalizedSearchResult>,
): SearchProvider {
  return { name, isConfigured: () => true, search: behavior };
}

function ok(name: string, titles: string[]): Promise<NormalizedSearchResult> {
  return Promise.resolve({
    results: titles.map((t) => ({ title: t, url: `https://${name}.example`, snippet: "" })),
    _meta: { provider: name, total_latency_ms: 0, attempts: [] },
  });
}

describe("probeProvider", () => {
  it("reports a successful probe with latency, count and first title", async () => {
    const row = await probeProvider(provider("a", () => ok("a", ["First title", "Second"])), req, {
      timeoutMs: 1_000,
    });
    expect(row).toMatchObject({ provider: "a", ok: true, results: 2, sample: "First title", error: "" });
    expect(row.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("reports an empty but successful search honestly", async () => {
    const row = await probeProvider(provider("a", () => ok("a", [])), req, { timeoutMs: 1_000 });
    expect(row).toMatchObject({ ok: true, results: 0, sample: "(no results)" });
  });

  it("converts a failure into a data row instead of throwing", async () => {
    const row = await probeProvider(
      provider("b", () => Promise.reject(new Error("fetch failed"))),
      req,
      { timeoutMs: 1_000 },
    );
    expect(row.ok).toBe(false);
    expect(row.error).toContain("fetch failed");
    expect(row.results).toBe(0);
  });

  it("honours its own timeout for hung providers", async () => {
    const hung = provider(
      "c",
      (_r, ctx) => new Promise<NormalizedSearchResult>((_res, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    );
    const row = await probeProvider(hung, req, { timeoutMs: 30 });
    expect(row.ok).toBe(false);
    expect(row.error).toContain("aborted");
  });

  it("truncates a very long first title in the sample field", async () => {
    const row = await probeProvider(provider("a", () => ok("a", ["T".repeat(100)])), req, { timeoutMs: 1_000 });
    expect(row.sample).toHaveLength(60);
  });
});

describe("probeAll", () => {
  it("probes every provider sequentially and preserves order", async () => {
    const order: string[] = [];
    const make = (name: string, fail = false): SearchProvider =>
      provider(name, () => {
        order.push(name);
        return fail ? Promise.reject(new Error(`${name} down`)) : ok(name, [`${name} title`]);
      });
    const rows = await probeAll([make("a"), make("b", true), make("c")], req, { timeoutMs: 1_000 });
    expect(rows.map((r) => r.provider)).toEqual(["a", "b", "c"]);
    expect(rows.map((r) => r.ok)).toEqual([true, false, true]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("returns an empty list for an empty provider list", async () => {
    expect(await probeAll([], req, { timeoutMs: 100 })).toEqual([]);
  });
});
