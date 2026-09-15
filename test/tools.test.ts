/**
 * @file test/tools
 * @description Tool layer unit tests: argument validation (strategy/provider subsets), defaults,
 * structured failures and dependency injection.
 */

import { describe, expect, it, vi } from "vitest";
import { buildToolDefinitions, createGatewayTools, textContent } from "../src/tools.js";
import { AllProvidersFailedError } from "../src/orchestrator.js";
import { HttpError } from "../src/errors.js";
import { loadConfig } from "../src/config.js";
import type { AttemptRecord, NormalizedSearchResult, SearchProvider, SearchRequest } from "../src/types.js";

function fakeProvider(name: string, behavior?: (req: SearchRequest) => Promise<NormalizedSearchResult>): SearchProvider {
  return {
    name,
    isConfigured: () => true,
    search:
      behavior ??
      (async () => ({
        results: [{ title: `${name} title`, url: `https://${name}.example`, snippet: "" }],
        _meta: { provider: name, total_latency_ms: 0, attempts: [] },
      })),
  };
}

const alive = (): SearchProvider => fakeProvider("stepfun");

function deps(chain: SearchProvider[], over: Partial<Parameters<typeof createGatewayTools>[0]> = {}) {
  return {
    config: loadConfig({ env: { STEPFUN_API_KEY: "s", KIMI_API_KEY: "k" }, warn: () => {} }),
    chain,
    ...over,
  };
}

function parse(out: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(out.content[0]!.text);
}

describe("buildToolDefinitions", () => {
  it("exposes exactly two tools and reflects the configured defaults", () => {
    const defs = buildToolDefinitions(12, "aggregate");
    expect(defs.map((t) => t.name)).toEqual(["web_search", "provider_status"]);
    const search = defs[0]!.inputSchema.properties as Record<string, any>;
    expect(search.count!.default).toBe(12);
    expect(search.strategy!.default).toBe("aggregate");
    expect(search.strategy!.enum).toEqual(["fallback", "aggregate"]);
  });
});

describe("provider_status", () => {
  it("reports settings, per-provider flags and never echoes the API key", async () => {
    const tools = createGatewayTools(deps([alive()]));
    const out = await tools.call("provider_status", {});
    const body = parse(out);
    expect(body.strategy).toBe("fallback");
    expect(body.order).toEqual(["kimi", "mimo", "stepfun", "zhipu"]);
    expect(body.config_file).toBeNull();

    const byName = Object.fromEntries(body.providers.map((p: any) => [p.name, p]));
    expect(byName.stepfun).toMatchObject({ enabled: true, configured: true, in_chain: true, priority: 0 });
    expect(byName.kimi).toMatchObject({ configured: true, in_chain: false });
    expect(byName.zhipu).toMatchObject({ configured: false, in_chain: false, model: null, timeout_ms: null });
    // Status output echoes only whether a key is configured, never the key itself.
    expect(out.content[0]!.text).not.toContain('"apiKey"');
    expect(out.content[0]!.text).not.toContain("s-key");
  });
});

describe("web_search argument validation", () => {
  it("rejects a missing or empty query", async () => {
    const tools = createGatewayTools(deps([alive()]));
    for (const args of [{}, { query: "" }, { query: "   " }, { query: 42 }]) {
      const out = await tools.call("web_search", args as Record<string, unknown>);
      expect(out.isError).toBe(true);
      expect(parse(out).error).toContain("'query' must be a non-empty string");
    }
  });

  it("rejects an unknown strategy", async () => {
    const out = await createGatewayTools(deps([alive()])).call("web_search", { query: "q", strategy: "turbo" });
    expect(out.isError).toBe(true);
    expect(parse(out).error).toContain("'strategy' must be one of fallback, aggregate");
  });

  it("rejects a malformed providers argument", async () => {
    const tools = createGatewayTools(deps([alive()]));
    for (const providers of ["stepfun", [1, 2], []]) {
      const out = await tools.call("web_search", { query: "q", providers });
      expect(out.isError).toBe(true);
      expect(parse(out).error).toContain("'providers'");
    }
  });

  it("names unknown providers and unavailable ones explicitly", async () => {
    const tools = createGatewayTools(deps([alive()]));
    const unknown = parse(await tools.call("web_search", { query: "q", providers: ["openai"] }));
    expect(unknown.error).toContain("unknown provider(s): openai");
    const missing = parse(await tools.call("web_search", { query: "q", providers: ["zhipu"] }));
    expect(missing.error).toContain("provider(s) unavailable: zhipu");
  });

  it("trims and truncates an over-long query", async () => {
    let seen: SearchRequest | undefined;
    const p = fakeProvider("stepfun", async (req) => {
      seen = req;
      return { results: [], _meta: { provider: "stepfun", total_latency_ms: 0, attempts: [] } };
    });
    await createGatewayTools(deps([p])).call("web_search", { query: `  ${"x".repeat(500)}  ` });
    expect(seen!.query).toHaveLength(400);
  });

  it("clamps an out-of-range count and defaults it from config", async () => {
    const seen: number[] = [];
    const p = fakeProvider("stepfun", async (req) => {
      seen.push(req.count);
      return { results: [], _meta: { provider: "stepfun", total_latency_ms: 0, attempts: [] } };
    });
    const tools = createGatewayTools({ ...deps([p]), config: loadConfig({ env: {}, warn: () => {} }) });
    await tools.call("web_search", { query: "q" });
    await tools.call("web_search", { query: "q", count: 999 });
    await tools.call("web_search", { query: "q", count: 0 });
    await tools.call("web_search", { query: "q", count: "7" });
    expect(seen).toEqual([8, 50, 1, 7]);
  });
});

describe("web_search dispatch", () => {
  it("passes the configured strategy and settings through to the search function", async () => {
    let seen: any;
    const tools = createGatewayTools(
      deps([alive()], {
        searchFn: async (req, opts) => {
          seen = { req, opts };
          return { results: [], _meta: { provider: "stepfun", total_latency_ms: 1, attempts: [] } };
        },
      }),
    );
    await tools.call("web_search", { query: "hello" });
    expect(seen.req).toEqual({ query: "hello", count: 8 });
    expect(seen.opts).toMatchObject({ strategy: "fallback", timeoutMs: 30_000, maxProviders: 4, dedupe: true });
  });

  it("honours a per-call strategy and provider subset", async () => {
    let seen: any;
    const tools = createGatewayTools(
      deps([alive(), fakeProvider("kimi")], {
        searchFn: async (_req, opts) => {
          seen = opts;
          return { results: [], _meta: { provider: "kimi", total_latency_ms: 1, attempts: [] } };
        },
      }),
    );
    await tools.call("web_search", { query: "q", strategy: "aggregate", providers: ["kimi"] });
    expect(seen.strategy).toBe("aggregate");
    expect(seen.providers.map((p: SearchProvider) => p.name)).toEqual(["kimi"]);
  });

  it("returns the orchestrator payload unchanged on success", async () => {
    const out = await createGatewayTools(deps([alive()])).call("web_search", { query: "q" });
    expect(out.isError).toBeUndefined();
    const body = parse(out);
    expect(body._meta.provider).toBe("stepfun");
    expect(body.results).toHaveLength(1);
  });

  it("formats all-providers-failed as isError with the attempt trail", async () => {
    const failing = (name: string): SearchProvider => ({
      name,
      isConfigured: () => true,
      search: async () => {
        throw new HttpError(401, `HTTP 401: bad key (${name})`);
      },
    });
    const out = await createGatewayTools(deps([failing("a"), failing("b")])).call("web_search", { query: "q" });
    expect(out.isError).toBe(true);
    const body = parse(out);
    expect(body.error).toContain("all configured providers failed");
    expect(body.attempts.map((a: AttemptRecord) => a.provider)).toEqual(["a", "b"]);
  });

  it("formats unexpected errors as isError without throwing", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await createGatewayTools(deps([])).call("web_search", { query: "q" });
    expect(out.isError).toBe(true);
    expect(parse(out).error).toContain("no provider is configured");
    expect(parse(out).attempts).toEqual([]);
    expect(errSpy).toHaveBeenCalledOnce();
    errSpy.mockRestore();
  });

  it("stringifies non-Error unexpected failures", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tools = createGatewayTools(
      deps([alive()], {
        searchFn: async () => {
          throw "plain string failure";
        },
      }),
    );
    const out = await tools.call("web_search", { query: "q" });
    expect(parse(out)).toEqual({ error: "plain string failure", attempts: [] });
    errSpy.mockRestore();
  });

  it("falls through a dead provider to the next one (real orchestrator)", async () => {
    const dead: SearchProvider = {
      name: "dead",
      isConfigured: () => true,
      search: async () => {
        throw new AllProvidersFailedError([{ provider: "dead", status: "permanent_error", latency_ms: 1 }]);
      },
    };
    const out = await createGatewayTools(deps([dead, fakeProvider("alive")])).call("web_search", { query: "q" });
    expect(out.isError).toBeUndefined();
    expect(parse(out)._meta.provider).toBe("alive");
  });
});

describe("unknown tools and textContent", () => {
  it("rejects unknown tools", async () => {
    const out = await createGatewayTools(deps([])).call("nope", {});
    expect(out.isError).toBe(true);
    expect(parse(out).error).toBe("unknown tool: nope");
  });

  it("marks errors only when asked", () => {
    expect(textContent({ a: 1 })).toEqual({ content: [{ type: "text", text: '{\n  "a": 1\n}' }] });
    expect(textContent("x", true).isError).toBe(true);
  });
});
