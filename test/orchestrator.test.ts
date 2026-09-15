/**
 * @file test/orchestrator
 * @description Orchestration layer unit tests: retries, fallback, timeout circuit-breaking, multi-source aggregation and strategy dispatch.
 */

import { describe, expect, it } from "vitest";
import {
  AllProvidersFailedError,
  NoProviderConfiguredError,
  runSearch,
  searchAggregate,
  searchWithFallback,
} from "../src/orchestrator.js";
import { HttpError, NetworkError, TimeoutError } from "../src/errors.js";
import type { NormalizedSearchResult, SearchContext, SearchProvider, SearchRequest } from "../src/types.js";

const req: SearchRequest = { query: "q", count: 8 };
const opts = { timeoutMs: 1_000 };

function makeProvider(
  name: string,
  behavior: (req: SearchRequest, ctx: SearchContext, call: number) => Promise<NormalizedSearchResult>,
): { provider: SearchProvider; calls: () => number } {
  let n = 0;
  return {
    provider: {
      name,
      isConfigured: () => true,
      search: async (r, c) => behavior(r, c, ++n),
    },
    calls: () => n,
  };
}

function okResult(provider: string, items = 1): NormalizedSearchResult {
  return {
    results: Array.from({ length: items }, (_, i) => ({ title: `${provider}-${i}`, url: `https://${provider}.example/${i}`, snippet: "" })),
    _meta: { provider, total_latency_ms: 0, attempts: [] },
  };
}

describe("errors", () => {
  it("AllProvidersFailedError renders an empty trail when nothing was attempted", () => {
    expect(new AllProvidersFailedError([]).message).toBe("all configured providers failed: ");
  });

  it("NoProviderConfiguredError has an actionable message", () => {
    expect(new NoProviderConfiguredError().message).toContain("no provider is configured");
  });
});

describe("searchWithFallback", () => {
  it("throws NoProviderConfiguredError when the chain is empty", async () => {
    await expect(searchWithFallback(req, { ...opts, providers: [] })).rejects.toBeInstanceOf(NoProviderConfiguredError);
  });

  it("returns the first provider's result without calling the rest", async () => {
    const a = makeProvider("a", async () => okResult("a"));
    const b = makeProvider("b", async () => okResult("b"));
    const out = await searchWithFallback(req, { ...opts, providers: [a.provider, b.provider] });
    expect(out._meta.provider).toBe("a");
    expect(b.calls()).toBe(0);
    expect(out._meta.attempts).toEqual([{ provider: "a", status: "ok", latency_ms: expect.any(Number) }]);
    expect(out.results).toHaveLength(1);
  });

  it("retries once after a transient 500, then succeeds", async () => {
    const a = makeProvider("a", async (_r, _c, call) => {
      if (call === 1) throw new HttpError(500, "HTTP 500: boom");
      return okResult("a");
    });
    const out = await searchWithFallback(req, { ...opts, providers: [a.provider] });
    expect(a.calls()).toBe(2);
    expect(out._meta.attempts.map((x) => x.status)).toEqual(["transient_error", "ok"]);
  });

  it("retries once after a network error, then falls through on second failure", async () => {
    const a = makeProvider("a", async () => {
      throw new NetworkError("fetch failed");
    });
    const b = makeProvider("b", async () => okResult("b"));
    const out = await searchWithFallback(req, { ...opts, providers: [a.provider, b.provider] });
    expect(a.calls()).toBe(2);
    expect(out._meta.provider).toBe("b");
    expect(out._meta.attempts.map((x) => x.provider)).toEqual(["a", "a", "b"]);
  });

  it("does not retry permanent 4xx errors", async () => {
    const a = makeProvider("a", async () => {
      throw new HttpError(401, "HTTP 401: bad key");
    });
    const b = makeProvider("b", async () => okResult("b"));
    const out = await searchWithFallback(req, { ...opts, providers: [a.provider, b.provider] });
    expect(a.calls()).toBe(1);
    expect(out._meta.provider).toBe("b");
    expect(out._meta.attempts[0]).toMatchObject({ provider: "a", status: "permanent_error" });
  });

  it("aborts a hung provider at the timeout and falls through", async () => {
    const a = makeProvider(
      "a",
      (_r, ctx) => new Promise<NormalizedSearchResult>((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason));
      }),
    );
    const b = makeProvider("b", async () => okResult("b"));
    const out = await searchWithFallback(req, { ...opts, providers: [a.provider, b.provider], timeoutMs: 50 });
    expect(out._meta.provider).toBe("b");
    expect(out._meta.attempts[0]).toMatchObject({ provider: "a", status: "timeout" });
  });

  it("throws AllProvidersFailedError carrying every attempt when all fail", async () => {
    const a = makeProvider("a", async () => {
      throw new HttpError(401, "HTTP 401");
    });
    const b = makeProvider("b", async () => {
      throw new TimeoutError();
    });
    const err = await searchWithFallback(req, { ...opts, providers: [a.provider, b.provider] }).catch((e) => e);
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    expect((err as AllProvidersFailedError).attempts.map((x) => `${x.provider}:${x.status}`)).toEqual([
      "a:permanent_error",
      "b:transient_error",
      "b:transient_error",
    ]);
  });

  it("keeps empty results as a legitimate success", async () => {
    const a = makeProvider("a", async () => okResult("a", 0));
    const out = await searchWithFallback(req, { ...opts, providers: [a.provider] });
    expect(out.results).toEqual([]);
    expect(out._meta.provider).toBe("a");
    expect(out._meta.providers).toEqual(["a"]);
  });
});

describe("searchAggregate", () => {
  it("queries every provider and merges their items", async () => {
    const a = makeProvider("a", async () => okResult("a", 2));
    const b = makeProvider("b", async () => okResult("b", 2));
    const out = await searchAggregate(req, { ...opts, providers: [a.provider, b.provider] });
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
    expect(out.results).toHaveLength(4);
    expect(out._meta.provider).toBe("a");
    expect(out._meta.providers).toEqual(["a", "b"]);
    expect(out._meta.attempts.map((x) => `${x.provider}:${x.status}`)).toEqual(["a:ok", "b:ok"]);
  });

  it("returns partial results when only some providers fail", async () => {
    const dead = makeProvider("dead", async () => {
      throw new HttpError(401, "HTTP 401: bad key");
    });
    const alive = makeProvider("alive", async () => okResult("alive", 1));
    const out = await searchAggregate(req, { ...opts, providers: [dead.provider, alive.provider] });
    expect(out._meta.providers).toEqual(["alive"]);
    expect(out.results).toHaveLength(1);
    // Failure details remain in the audit trail for debugging.
    expect(out._meta.attempts[0]).toMatchObject({ provider: "dead", status: "permanent_error" });
  });

  it("throws AllProvidersFailedError when nobody answers", async () => {
    const a = makeProvider("a", async () => {
      throw new HttpError(500, "HTTP 500: boom");
    });
    const err = await searchAggregate(req, { ...opts, providers: [a.provider] }).catch((e) => e);
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    expect((err as AllProvidersFailedError).attempts).toHaveLength(2); // transient errors retry once
  });

  it("throws NoProviderConfiguredError for an empty provider list", async () => {
    await expect(searchAggregate(req, { ...opts, providers: [] })).rejects.toBeInstanceOf(NoProviderConfiguredError);
  });

  it("dedupes the same URL across providers by default, keeping priority order", async () => {
    const a = makeProvider("a", async () => ({
      results: [{ title: "a-title", url: "https://same.example/1?utm_source=a", snippet: "short" }],
      _meta: { provider: "a", total_latency_ms: 0, attempts: [] },
    }));
    const b = makeProvider("b", async () => ({
      results: [{ title: "b-title", url: "https://same.example/1", snippet: "a longer snippet" }],
      _meta: { provider: "b", total_latency_ms: 0, attempts: [] },
    }));
    const out = await searchAggregate(req, { ...opts, providers: [a.provider, b.provider] });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({
      title: "a-title",
      source: "a",
      snippet: "a longer snippet",
    });
  });

  it("keeps duplicates when dedupe is disabled, tagging each source", async () => {
    const a = makeProvider("a", async () => ({
      results: [{ title: "a", url: "https://same.example/1", snippet: "" }],
      _meta: { provider: "a", total_latency_ms: 0, attempts: [] },
    }));
    const b = makeProvider("b", async () => ({
      results: [{ title: "b", url: "https://same.example/1", snippet: "" }],
      _meta: { provider: "b", total_latency_ms: 0, attempts: [] },
    }));
    const out = await searchAggregate(req, { ...opts, providers: [a.provider, b.provider], dedupe: false });
    expect(out.results.map((r) => r.source)).toEqual(["a", "b"]);
  });

  it("caps the merged list at the requested count", async () => {
    const a = makeProvider("a", async () => okResult("a", 5));
    const b = makeProvider("b", async () => okResult("b", 5));
    const out = await searchAggregate({ query: "q", count: 3 }, { ...opts, providers: [a.provider, b.provider] });
    expect(out.results).toHaveLength(3);
  });

  it("labels synthesized answers per provider when several respond with one", async () => {
    const withAnswer = (name: string, answer: string): SearchProvider => ({
      name,
      isConfigured: () => true,
      search: async () => ({
        results: [],
        _meta: { provider: name, total_latency_ms: 0, attempts: [], answer },
      }),
    });
    const out = await searchAggregate(req, { ...opts, providers: [withAnswer("a", "A says"), withAnswer("b", "B says")] });
    expect(out._meta.answer).toBe("[a] A says\n\n[b] B says");
  });

  it("returns a single answer unlabelled and omits the field when there is none", async () => {
    const one: SearchProvider = {
      name: "a",
      isConfigured: () => true,
      search: async () => ({ results: [], _meta: { provider: "a", total_latency_ms: 0, attempts: [], answer: "only" } }),
    };
    const silent = makeProvider("b", async () => okResult("b", 1));
    expect((await searchAggregate(req, { ...opts, providers: [one] }))._meta.answer).toBe("only");
    expect((await searchAggregate(req, { ...opts, providers: [silent.provider, one] }))._meta.answer).toBe("only");
    const noAnswer = await searchAggregate(req, { ...opts, providers: [silent.provider] });
    expect(noAnswer._meta.answer).toBeUndefined();
  });
});

describe("runSearch", () => {
  it("dispatches to the fallback strategy", async () => {
    const a = makeProvider("a", async () => okResult("a", 1));
    const b = makeProvider("b", async () => okResult("b", 1));
    const out = await runSearch(req, { ...opts, providers: [a.provider, b.provider], strategy: "fallback" });
    expect(out._meta.provider).toBe("a");
    expect(b.calls()).toBe(0);
  });

  it("dispatches to the aggregate strategy", async () => {
    const a = makeProvider("a", async () => okResult("a", 1));
    const b = makeProvider("b", async () => okResult("b", 1));
    const out = await runSearch(req, { ...opts, providers: [a.provider, b.provider], strategy: "aggregate" });
    expect(out._meta.providers).toEqual(["a", "b"]);
    expect(b.calls()).toBe(1);
  });

  it("caps the number of participating providers with maxProviders", async () => {
    const a = makeProvider("a", async () => okResult("a", 1));
    const b = makeProvider("b", async () => okResult("b", 1));
    const out = await runSearch(req, {
      ...opts,
      providers: [a.provider, b.provider],
      strategy: "aggregate",
      maxProviders: 1,
    });
    expect(out._meta.providers).toEqual(["a"]);
    expect(b.calls()).toBe(0);
  });

  it("throws NoProviderConfiguredError when the capped list is empty", async () => {
    await expect(runSearch(req, { ...opts, providers: [], strategy: "fallback" })).rejects.toBeInstanceOf(
      NoProviderConfiguredError,
    );
  });

  it("honours a provider-specific timeout budget over the global one", async () => {
    const slow: SearchProvider = {
      name: "slow",
      timeoutMs: 20,
      isConfigured: () => true,
      search: (_r, ctx) =>
        new Promise<NormalizedSearchResult>((_res, reject) => {
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason));
        }),
    };
    const fast = makeProvider("fast", async () => okResult("fast", 1));
    const out = await runSearch(req, {
      providers: [slow, fast.provider],
      timeoutMs: 5_000,
      strategy: "fallback",
    });
    expect(out._meta.attempts[0]).toMatchObject({ provider: "slow", status: "timeout" });
    expect(out._meta.provider).toBe("fast");
  });
});
