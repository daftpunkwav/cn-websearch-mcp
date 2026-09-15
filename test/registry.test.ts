/**
 * @file test/registry
 * @description Provider registry unit tests: adapters built in configured order, each factory receives its own config.
 */

import { describe, expect, it } from "vitest";
import { buildProviders } from "../src/providers/index.js";
import { loadConfig } from "../src/config.js";

const env = (over: Record<string, string>): NodeJS.ProcessEnv => over;
const noWarn = (): void => {};

describe("buildProviders", () => {
  it("builds one adapter per order entry, in order", () => {
    const cfg = loadConfig({
      env: env({
        KIMI_API_KEY: "k",
        MIMO_API_KEY: "m",
        ZHIPU_API_KEY: "z",
        STEPFUN_API_KEY: "s",
        WEBSEARCH_ORDER: "kimi,zhipu,mimo,stepfun",
      }),
      warn: noWarn,
    });
    const providers = buildProviders(cfg);
    expect(providers.map((p) => p.name)).toEqual(["kimi", "zhipu", "mimo", "stepfun"]);
    for (const p of providers) expect(p.isConfigured()).toBe(true);
  });

  it("passes each provider's own config to its factory", () => {
    const cfg = loadConfig({ env: env({ STEPFUN_API_KEY: "s-key", KIMI_API_KEY: "" }), warn: noWarn });
    const providers = buildProviders(cfg);
    const stepfun = providers.find((p) => p.name === "stepfun")!;
    const kimi = providers.find((p) => p.name === "kimi")!;
    expect(stepfun.isConfigured()).toBe(true);
    expect(kimi.isConfigured()).toBe(false);
  });

  it("carries the per-provider timeout budget into the adapter", () => {
    const cfg = loadConfig({ env: env({ KIMI_TIMEOUT_MS: "1234" }), warn: noWarn });
    const kimi = buildProviders(cfg).find((p) => p.name === "kimi")!;
    expect(kimi.timeoutMs).toBe(1234);
  });
});
