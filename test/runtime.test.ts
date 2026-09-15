/**
 * @file test/runtime
 * @description Runtime assembly unit tests: config file loading, enabled/key filtering and warning degradation.
 */

import { describe, expect, it } from "vitest";
import { createRuntime } from "../src/runtime.js";

const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => over;

describe("createRuntime", () => {
  it("builds providers in configured order and keeps only enabled+keyed ones in the chain", () => {
    const runtime = createRuntime({
      env: env({
        KIMI_API_KEY: "k",
        STEPFUN_API_KEY: "s",
        ZHIPU_API_KEY: "z",
        MIMO_API_KEY: "m",
        WEBSEARCH_ORDER: "zhipu,mimo,kimi,stepfun",
        ZHIPU_ENABLED: "false",
      }),
      warn: () => {},
      configPath: undefined,
    });
    expect(runtime.providers.map((p) => p.name)).toEqual(["zhipu", "mimo", "kimi", "stepfun"]);
    // zhipu has a key but is explicitly disabled; mimo/kimi/stepfun participate in search.
    expect(runtime.chain.map((p) => p.name)).toEqual(["mimo", "kimi", "stepfun"]);
  });

  it("excludes providers without a key", () => {
    const runtime = createRuntime({ env: env({ STEPFUN_API_KEY: "s" }), warn: () => {}, configPath: undefined });
    expect(runtime.chain.map((p) => p.name)).toEqual(["stepfun"]);
  });

  it("produces an empty chain when no key is configured at all", () => {
    const runtime = createRuntime({ env: env(), warn: () => {}, configPath: undefined });
    expect(runtime.chain).toEqual([]);
    expect(runtime.providers).toHaveLength(4);
  });

  it("loads and applies a config file (priority, strategy, per-provider settings)", () => {
    const runtime = createRuntime({
      env: env({ STEPFUN_API_KEY: "s", KIMI_API_KEY: "k" }),
      warn: () => {},
      configPath: "/cfg.json",
      readFile: () =>
        JSON.stringify({
          strategy: "aggregate",
          order: ["stepfun", "kimi"],
          providers: { kimi: { enabled: false, options: { maxRounds: 3 } } },
        }),
    });
    expect(runtime.config.strategy).toBe("aggregate");
    expect(runtime.config.order).toEqual(["stepfun", "kimi"]);
    expect(runtime.config.configFile).toBe("/cfg.json");
    expect(runtime.config.providers.kimi.options).toEqual({ maxRounds: 3 });
    expect(runtime.chain.map((p) => p.name)).toEqual(["stepfun"]);
  });

  it("keeps running with defaults when the config file is broken", () => {
    const warnings: string[] = [];
    const runtime = createRuntime({
      env: env({ STEPFUN_API_KEY: "s" }),
      warn: (m) => warnings.push(m),
      configPath: "/broken.json",
      readFile: () => "{not json",
    });
    expect(warnings.some((w) => w.includes("not valid JSON"))).toBe(true);
    expect(runtime.config.strategy).toBe("fallback");
    expect(runtime.chain.map((p) => p.name)).toEqual(["stepfun"]);
  });

  it("discovers the conventional config file when present", () => {
    const runtime = createRuntime({
      env: env(),
      warn: () => {},
      cwd: "/work",
      fileExists: (p) => p.includes("cn-websearch.config.json"),
      readFile: () => JSON.stringify({ count: 4 }),
    });
    expect(runtime.config.count).toBe(4);
    expect(runtime.config.configFile).toContain("cn-websearch.config.json");
  });
});
