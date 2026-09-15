/**
 * @file test/cli-commands
 * @description CLI one-shot command tests: output, exit codes and error paths of search/status/test.
 */

import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { cmdSearch, cmdStatus, cmdTest, pickProviders } from "../src/cli/commands.js";
import { createRuntime } from "../src/runtime.js";
import { loadConfig } from "../src/config.js";
import { AllProvidersFailedError, NoProviderConfiguredError } from "../src/orchestrator.js";
import { HttpError } from "../src/errors.js";
import type { CliArgs } from "../src/cli/args.js";
import type { CliDeps } from "../src/cli/commands.js";
import type { NormalizedSearchResult, SearchProvider } from "../src/types.js";

const searchArgs = (over: Partial<CliArgs> = {}): CliArgs => ({
  command: "search",
  query: "q",
  json: false,
  ...over,
});

function makeDeps(
  over: {
    env?: Record<string, string>;
    search?: CliDeps["search"];
    probe?: CliDeps["probe"];
  } = {},
): { deps: CliDeps; out: string[]; err: string[] } {
  const runtime = createRuntime({
    env: over.env ?? { STEPFUN_API_KEY: "s", KIMI_API_KEY: "k" },
    warn: () => {},
    configPath: undefined,
  });
  const out: string[] = [];
  const err: string[] = [];
  const stream = (sink: string[]): NodeJS.WritableStream => {
    const s = new PassThrough();
    s.on("data", (c) => sink.push(c.toString()));
    return s;
  };
  return {
    deps: { runtime, output: stream(out), error: stream(err), search: over.search, probe: over.probe },
    out,
    err,
  };
}

const okResult = (provider: string): NormalizedSearchResult => ({
  results: [{ title: "T", url: "https://a.example", snippet: "S", source: provider }],
  _meta: { provider, providers: [provider], total_latency_ms: 10, attempts: [{ provider, status: "ok", latency_ms: 9 }] },
});

describe("pickProviders", () => {
  const chain: SearchProvider[] = [
    { name: "kimi", isConfigured: () => true, search: async () => okResult("kimi") },
    { name: "stepfun", isConfigured: () => true, search: async () => okResult("stepfun") },
  ];

  it("defaults to the whole chain", () => {
    const picked = pickProviders(undefined, chain);
    expect(picked.ok && picked.providers).toHaveLength(2);
    expect(pickProviders([], chain)).toMatchObject({ ok: true });
  });

  it("selects a subset in the requested order", () => {
    const picked = pickProviders(["stepfun", "kimi"], chain);
    expect(picked.ok && picked.providers.map((p) => p.name)).toEqual(["stepfun", "kimi"]);
  });

  it("reports unknown and unavailable names", () => {
    expect(pickProviders(["openai"], chain)).toMatchObject({ ok: false });
    expect((pickProviders(["openai"], chain) as { error: string }).error).toContain("unknown provider(s): openai");
    const unavailable = pickProviders(["zhipu"], chain) as { error: string };
    expect(unavailable.error).toContain("provider(s) unavailable: zhipu");
  });
});

describe("cmdSearch", () => {
  it("prints formatted results and returns 0", async () => {
    const { deps, out, err } = makeDeps({ search: async () => okResult("stepfun") });
    expect(await cmdSearch(deps, searchArgs())).toBe(0);
    expect(out.join("")).toContain("answered by: stepfun");
    expect(err).toEqual([]);
  });

  it("prints raw JSON with --json", async () => {
    const { deps, out } = makeDeps({ search: async () => okResult("stepfun") });
    await cmdSearch(deps, searchArgs({ json: true }));
    expect(JSON.parse(out.join(""))).toHaveProperty("_meta.provider", "stepfun");
  });

  it("passes CLI overrides to the search function", async () => {
    let seen: any;
    const { deps } = makeDeps({
      search: async (_req, opts) => {
        seen = opts;
        return okResult("kimi");
      },
    });
    await cmdSearch(deps, searchArgs({ strategy: "aggregate", dedupe: false, providers: ["kimi"], count: 3 }));
    expect(seen).toMatchObject({ strategy: "aggregate", dedupe: false });
    expect(seen.providers.map((p: SearchProvider) => p.name)).toEqual(["kimi"]);
  });

  it("falls back to the configured strategy when none is given", async () => {
    let seen: any;
    const { deps } = makeDeps({
      search: async (_req, opts) => {
        seen = opts;
        return okResult("kimi");
      },
    });
    await cmdSearch(deps, searchArgs());
    expect(seen.strategy).toBe("fallback");
  });

  it("returns 2 for a missing query and 2 for an unusable provider list", async () => {
    const { deps, err } = makeDeps();
    expect(await cmdSearch(deps, searchArgs({ query: "  " }))).toBe(2);
    expect(err.join("")).toContain("missing query");
    expect(await cmdSearch(deps, searchArgs({ providers: ["openai"] }))).toBe(2);
  });

  it("returns 1 with a hint when no provider is ready", async () => {
    const { deps, err } = makeDeps({ env: {} });
    expect(await cmdSearch(deps, searchArgs())).toBe(1);
    expect(err.join("")).toContain("no provider is ready");
  });

  it("returns 1 and lists every attempt when all providers fail", async () => {
    const { deps, err } = makeDeps({
      search: async () => {
        throw new AllProvidersFailedError([
          { provider: "kimi", status: "transient_error", latency_ms: 3, error: "HTTP 429" },
        ]);
      },
    });
    expect(await cmdSearch(deps, searchArgs())).toBe(1);
    expect(err.join("")).toContain("all configured providers failed");
    expect(err.join("")).toContain("- kimi: transient_error (3ms) HTTP 429");
  });

  it("returns 1 for NoProviderConfiguredError and for unexpected failures", async () => {
    const noProvider = makeDeps({
      search: async () => {
        throw new NoProviderConfiguredError();
      },
    });
    expect(await cmdSearch(noProvider.deps, searchArgs())).toBe(1);
    expect(noProvider.err.join("")).toContain("no provider is configured");

    const boom = makeDeps({
      search: async () => {
        throw new Error("boom");
      },
    });
    expect(await cmdSearch(boom.deps, searchArgs())).toBe(1);
    expect(boom.err.join("")).toContain("unexpected failure: Error: boom");
  });

  it("stringifies non-Error failures", async () => {
    const { deps, err } = makeDeps({
      search: async () => {
        throw "string failure";
      },
    });
    expect(await cmdSearch(deps, searchArgs())).toBe(1);
    expect(err.join("")).toContain("string failure");
  });
});

describe("cmdStatus", () => {
  it("prints the human-readable status", async () => {
    const { deps, out } = makeDeps();
    expect(await cmdStatus(deps, { command: "status", query: "", json: false })).toBe(0);
    expect(out.join("")).toContain("in-chain");
  });

  it("prints redacted JSON with --json and leaks no key", async () => {
    const { deps, out } = makeDeps({ env: { KIMI_API_KEY: "very-secret" } });
    await cmdStatus(deps, { command: "status", query: "", json: true });
    const text = out.join("");
    expect(text).not.toContain("very-secret");
    expect(JSON.parse(text).providers.kimi.apiKey).toBe("(set)");
  });
});

describe("cmdTest", () => {
  it("returns 0 when every probe succeeds", async () => {
    const { deps, out } = makeDeps({
      probe: async (providers) =>
        providers.map((p) => ({ provider: p.name, ok: true, latency_ms: 1, results: 1, sample: "T", error: "" })),
    });
    expect(await cmdTest(deps, { command: "test", query: "", json: false })).toBe(0);
    expect(out.join("")).toContain("provider   status");
  });

  it("returns 1 when any probe fails and prints raw JSON when asked", async () => {
    const { deps, out } = makeDeps({
      probe: async (providers) =>
        providers.map((p, i) => ({
          provider: p.name,
          ok: i === 0,
          latency_ms: 1,
          results: i === 0 ? 1 : 0,
          sample: "",
          error: i === 0 ? "" : "down",
        })),
    });
    expect(await cmdTest(deps, { command: "test", query: "", json: true })).toBe(1);
    expect(Array.isArray(JSON.parse(out.join("")))).toBe(true);
  });

  it("uses the provided query, else the neutral default probe query", async () => {
    const seen: string[] = [];
    const { deps } = makeDeps({
      probe: async (providers, req) => {
        seen.push(req.query);
        return providers.map((p) => ({ provider: p.name, ok: true, latency_ms: 1, results: 0, sample: "", error: "" }));
      },
    });
    await cmdTest(deps, { command: "test", query: "custom", json: false });
    await cmdTest(deps, { command: "test", query: "", json: false });
    expect(seen).toEqual(["custom", "今日新闻"]);
  });

  it("returns 2 for an unusable provider list and 1 when nothing is ready", async () => {
    const { deps, err } = makeDeps();
    expect(await cmdTest(deps, { command: "test", query: "", providers: ["openai"], json: false })).toBe(2);
    const empty = makeDeps({ env: {} });
    expect(await cmdTest(empty.deps, { command: "test", query: "", json: false })).toBe(1);
    expect(empty.err.join("")).toContain("no provider is ready");
    expect(err.join("")).toContain("unknown provider");
  });
});

describe("default (non-injected) code paths", () => {
  // In production neither search nor probe is injected; use a non-network fake runtime here
  // to cover the default implementations (deps.search ?? runSearch / deps.probe ?? probeAll).
  const fake = (name: string): SearchProvider => ({
    name,
    isConfigured: () => true,
    search: async () => ({
      results: [{ title: `${name} hit`, url: `https://${name}.example/1`, snippet: "s" }],
      _meta: { provider: name, total_latency_ms: 1, attempts: [{ provider: name, status: "ok", latency_ms: 1 }] },
    }),
  });

  const sink = (target: string[]): NodeJS.WritableStream => {
    const s = new PassThrough();
    s.on("data", (c) => target.push(c.toString()));
    return s;
  };

  function ioFor(providers: SearchProvider[] = [fake("stepfun")]): {
    deps: CliDeps;
    out: () => string;
    err: () => string;
  } {
    const out: string[] = [];
    const err: string[] = [];
    const runtime = {
      config: loadConfig({ env: { STEPFUN_API_KEY: "s" }, warn: () => {} }),
      providers,
      chain: providers,
    };
    return { deps: { runtime, output: sink(out), error: sink(err) }, out: () => out.join(""), err: () => err.join("") };
  }

  it("searches through the real orchestrator when no search function is injected", async () => {
    const { deps, out } = ioFor();
    expect(await cmdSearch(deps, searchArgs())).toBe(0);
    expect(out()).toContain("answered by: stepfun");
  });

  it("probes through the real probeAll when no probe function is injected", async () => {
    const { deps, out } = ioFor();
    expect(await cmdTest(deps, { command: "test", query: "q", json: false })).toBe(0);
    expect(out()).toContain("stepfun hit");
  });

  it("still formats an all-failed search when using the real orchestrator", async () => {
    const broken: SearchProvider = {
      name: "stepfun",
      isConfigured: () => true,
      search: async () => {
        throw new HttpError(401, "HTTP 401: bad key");
      },
    };
    const { deps, err } = ioFor([broken]);
    expect(await cmdSearch(deps, searchArgs())).toBe(1);
    expect(err()).toContain("all configured providers failed");
  });
});

describe("CliDeps contract", () => {
  it("does not write anything to the real process streams", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { deps } = makeDeps({ search: async () => okResult("stepfun") });
    await cmdSearch(deps, searchArgs());
    expect(stdout).not.toHaveBeenCalled();
    stdout.mockRestore();
  });
});
