/**
 * @file test/provider-selection
 * @description Provider-name rules shared by the MCP tool layer, the one-shot CLI and the REPL.
 */

import { describe, expect, it } from "vitest";
import { parseProviderNames, selectProviders } from "../src/provider-selection.js";
import type { NormalizedSearchResult, SearchProvider } from "../src/types.js";

const ok = (name: string): SearchProvider => ({
  name,
  search: async (): Promise<NormalizedSearchResult> => ({
    results: [],
    _meta: { provider: name, total_latency_ms: 0, attempts: [] },
  }),
});

const chain: SearchProvider[] = [ok("kimi"), ok("stepfun"), ok("zhipu")];

describe("parseProviderNames", () => {
  it("normalizes case, trims and dedupes while keeping order", () => {
    expect(parseProviderNames(" StepFun , KIMI ,stepfun ")).toEqual({ ok: true, names: ["stepfun", "kimi"] });
  });

  it("rejects unknown names and reports every offender", () => {
    const out = parseProviderNames("kimi,openai,bing");
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toBe("unknown provider(s): openai, bing (known: kimi, mimo, stepfun, zhipu)");
  });

  it("rejects a list that normalizes to nothing", () => {
    const out = parseProviderNames(" , ,");
    expect(out).toEqual({ ok: false, error: "provider list must not be empty" });
  });
});

describe("selectProviders", () => {
  it("returns the whole chain when nothing is requested", () => {
    expect(selectProviders(undefined, chain)).toEqual({ ok: true, providers: chain });
  });

  it("resolves a subset in the requested order", () => {
    const out = selectProviders(["zhipu", "kimi"], chain);
    expect(out.ok && out.providers.map((p) => p.name)).toEqual(["zhipu", "kimi"]);
  });

  it("rejects a non-array request", () => {
    for (const bad of ["stepfun", 42, [1, 2], {}]) {
      const out = selectProviders(bad, chain);
      expect(out.ok).toBe(false);
      expect((out as { error: string }).error).toContain("must be an array of provider names");
    }
  });

  it("rejects an empty list instead of silently searching everything", () => {
    const out = selectProviders([], chain);
    expect(out).toEqual({ ok: false, error: "invalid arguments: 'providers' must not be empty" });
    expect(selectProviders(["  "], chain).ok).toBe(false);
  });

  it("names unknown providers", () => {
    const out = selectProviders(["openai"], chain);
    expect((out as { error: string }).error).toContain("unknown provider(s): openai");
  });

  it("distinguishes a known slot that is simply not usable", () => {
    const out = selectProviders(["mimo"], chain);
    expect((out as { error: string }).error).toBe(
      "provider(s) unavailable: mimo (disabled or missing API key)",
    );
  });
});
