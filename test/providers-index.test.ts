/**
 * @file test/providers-index
 * @description Provider factory registry unit tests: adapters built in configured order, each factory receives its own config.
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
  });

  it("passes each provider's own config to its factory", () => {
    // An adapter exposes only what its factory derived from the config it was
    // handed, so slots configured differently must come back with different
    // values: that is what shows a factory is not handed a shared config, and
    // also that a slot with nothing set is not back-filled from another slot.
    const cfg = loadConfig({
      env: env({ KIMI_TIMEOUT_MS: "1111", STEPFUN_TIMEOUT_MS: "2222" }),
      warn: noWarn,
    });
    const providers = buildProviders(cfg);
    expect(providers.find((p) => p.name === "kimi")!.timeoutMs).toBe(1111);
    expect(providers.find((p) => p.name === "stepfun")!.timeoutMs).toBe(2222);
    expect(providers.find((p) => p.name === "mimo")!.timeoutMs).toBeUndefined();
  });

  it("carries the per-provider timeout budget into the adapter", () => {
    const cfg = loadConfig({ env: env({ KIMI_TIMEOUT_MS: "1234" }), warn: noWarn });
    const kimi = buildProviders(cfg).find((p) => p.name === "kimi")!;
    expect(kimi.timeoutMs).toBe(1234);
  });
});
