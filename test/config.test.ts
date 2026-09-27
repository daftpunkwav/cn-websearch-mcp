/**
 * @file test/config
 * @description Config resolution unit tests: three-layer merge precedence, neutral default order, priority sorting and fault tolerance.
 */

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_COUNT,
  DEFAULT_MAX_PROVIDERS,
  DEFAULT_ORDER,
  DEFAULT_STRATEGY,
  DEFAULT_TIMEOUT_MS,
  KNOWN_PROVIDERS,
  loadConfig,
  parseProviderList,
  parseStrategy,
  providerEnvKey,
} from "../src/config.js";

const noWarn = (): void => {};
const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => over;

describe("neutral defaults", () => {
  it("ships an alphabetical default order (no built-in vendor preference)", () => {
    expect([...KNOWN_PROVIDERS]).toEqual([...KNOWN_PROVIDERS].sort());
    expect(DEFAULT_ORDER).toEqual([...KNOWN_PROVIDERS]);
    expect(loadConfig({ env: env(), warn: noWarn }).order).toEqual([...KNOWN_PROVIDERS]);
  });

  it("applies neutral defaults for every gateway setting", () => {
    const cfg = loadConfig({ env: env(), warn: noWarn });
    expect(cfg.strategy).toBe(DEFAULT_STRATEGY);
    expect(cfg.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(cfg.count).toBe(DEFAULT_COUNT);
    expect(cfg.maxProviders).toBe(DEFAULT_MAX_PROVIDERS);
    expect(cfg.dedupe).toBe(true);
    expect(cfg.configFile).toBeUndefined();
  });

  it("gives every provider neutral defaults: enabled, priority 0, no personal options", () => {
    const cfg = loadConfig({ env: env(), warn: noWarn });
    for (const name of KNOWN_PROVIDERS) {
      expect(cfg.providers[name]).toMatchObject({ enabled: true, priority: 0, apiKey: "" });
      expect(cfg.providers[name].timeoutMs).toBeUndefined();
    }
    // mimo's location options no longer ship any built-in city/province.
    expect(cfg.providers.mimo.options).toBeUndefined();
  });

  it("uses the official base URLs and appends /v1 only for OpenAI-compatible providers", () => {
    const cfg = loadConfig({ env: env(), warn: noWarn });
    expect(cfg.providers.kimi.baseUrl).toBe("https://api.moonshot.cn/v1");
    expect(cfg.providers.mimo.baseUrl).toBe("https://token-plan-cn.xiaomimimo.com/v1");
    expect(cfg.providers.stepfun.baseUrl).toBe("https://api.stepfun.com");
    expect(cfg.providers.zhipu.baseUrl).toBe("https://open.bigmodel.cn");
  });
});

describe("provider env vars are derived from the provider name", () => {
  it("derives <NAME>_<SUFFIX>", () => {
    expect(providerEnvKey("stepfun", "API_KEY")).toBe("STEPFUN_API_KEY");
    expect(providerEnvKey("zhipu", "TIMEOUT_MS")).toBe("ZHIPU_TIMEOUT_MS");
  });

  it("reads keys, models, enable flags, priority and per-provider timeout", () => {
    const cfg = loadConfig({
      env: env({
        STEPFUN_API_KEY: "s-key",
        STEPFUN_MODEL: "step-x",
        STEPFUN_PRIORITY: "5",
        STEPFUN_TIMEOUT_MS: "45000",
        ZHIPU_ENABLED: "false",
      }),
      warn: noWarn,
    });
    expect(cfg.providers.stepfun).toMatchObject({
      apiKey: "s-key",
      model: "step-x",
      priority: 5,
      timeoutMs: 45000,
    });
    expect(cfg.providers.zhipu.enabled).toBe(false);
  });

  it("accepts bare hosts for OpenAI-compatible providers without doubling /v1", () => {
    const cfg = loadConfig({
      env: env({ KIMI_BASE_URL: "https://api.moonshot.cn", MIMO_BASE_URL: "https://x.example/v1/" }),
      warn: noWarn,
    });
    expect(cfg.providers.kimi.baseUrl).toBe("https://api.moonshot.cn/v1");
    expect(cfg.providers.mimo.baseUrl).toBe("https://x.example/v1");
  });
});

describe("blank values never mask a lower layer", () => {
  // Template files ship empty placeholders (`KIMI_API_KEY=`), and the env layer
  // sits above the config file, so a blank value must count as "unset".
  it("falls back to the config file when an env key or base URL is blank", () => {
    const cfg = loadConfig({
      env: env({ KIMI_API_KEY: "", STEPFUN_BASE_URL: "  " }),
      warn: noWarn,
      file: {
        providers: {
          kimi: { apiKey: "from-file", baseUrl: "https://kimi-file.example" },
          stepfun: { baseUrl: "https://stepfun-file.example" },
        },
      },
    });
    expect(cfg.providers.kimi.apiKey).toBe("from-file");
    expect(cfg.providers.kimi.baseUrl).toBe("https://kimi-file.example/v1");
    expect(cfg.providers.stepfun.baseUrl).toBe("https://stepfun-file.example");
  });

  it("falls back to built-in defaults when both layers are blank", () => {
    const defaults = loadConfig({ env: env(), warn: noWarn });
    const cfg = loadConfig({
      env: env({ STEPFUN_API_KEY: "", STEPFUN_BASE_URL: "" }),
      warn: noWarn,
      file: { providers: { stepfun: { apiKey: "", baseUrl: "" } } },
    });
    expect(cfg.providers.stepfun.apiKey).toBe("");
    expect(cfg.providers.stepfun.baseUrl).toBe(defaults.providers.stepfun.baseUrl);
  });

  it("trims surrounding whitespace off keys and base URLs", () => {
    const cfg = loadConfig({ env: env({ KIMI_API_KEY: "  sk-padded  " }), warn: noWarn });
    expect(cfg.providers.kimi.apiKey).toBe("sk-padded");
  });
});

describe("timeout budgets are bounded", () => {
  // A delay beyond 2^31-1 silently becomes 1ms in setTimeout, which would turn
  // a typo'd timeout into "every request times out instantly".
  it("warns and falls back when the global timeout exceeds the maximum", () => {
    const warnings: string[] = [];
    const cfg = loadConfig({ env: env({ WEBSEARCH_TIMEOUT_MS: "3000000000" }), warn: (m) => warnings.push(m) });
    expect(cfg.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(warnings.some((w) => w.includes("WEBSEARCH_TIMEOUT_MS") && w.includes("exceeds the maximum"))).toBe(true);
  });

  it("keeps a large but valid timeout and rejects an absurd per-provider one", () => {
    const warnings: string[] = [];
    const ok = loadConfig({ env: env({ WEBSEARCH_TIMEOUT_MS: "600000" }), warn: (m) => warnings.push(m) });
    expect(ok.timeoutMs).toBe(600_000);
    expect(warnings).toEqual([]);

    const bad = loadConfig({ env: env({ STEPFUN_TIMEOUT_MS: "3000000000" }), warn: (m) => warnings.push(m) });
    expect(bad.providers.stepfun.timeoutMs).toBeUndefined();
    expect(warnings.some((w) => w.includes("STEPFUN_TIMEOUT_MS") && w.includes("global timeout"))).toBe(true);
  });

  it("names the config file when the global timeout comes from there", () => {
    const warnings: string[] = [];
    const cfg = loadConfig({ env: env(), warn: (m) => warnings.push(m), file: { timeoutMs: 3_000_000_000 } });
    expect(cfg.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    // Not the environment variable the user never set.
    expect(warnings[0]).toContain("config timeoutMs");
    expect(warnings[0]).not.toContain("WEBSEARCH_TIMEOUT_MS");
  });

  it("treats a per-provider 0 as 'no override' rather than a zero budget", () => {
    const warnings: string[] = [];
    const cfg = loadConfig({
      env: env({ KIMI_TIMEOUT_MS: "0" }),
      warn: (m) => warnings.push(m),
      file: { providers: { kimi: { timeoutMs: 9_000 } } },
    });
    // 0 is an explicit reset that must beat the file, and it must not be
    // reported as a 0 ms budget in a status payload.
    expect(cfg.providers.kimi.timeoutMs).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("bounds a per-provider timeout coming from the config file too", () => {
    const warnings: string[] = [];
    const cfg = loadConfig({ env: env(), warn: (m) => warnings.push(m), file: { providers: { kimi: { timeoutMs: 9_999_999_999 } } } });
    expect(cfg.providers.kimi.timeoutMs).toBeUndefined();
    // The warning must name the file field, not an env var the user never set.
    expect(warnings[0]).toContain("config providers.kimi.timeoutMs");
  });

  it("names the environment variable when that is where the value came from", () => {
    const warnings: string[] = [];
    loadConfig({ env: env({ STEPFUN_TIMEOUT_MS: "9999999999" }), warn: (m) => warnings.push(m) });
    expect(warnings[0]).toContain("STEPFUN_TIMEOUT_MS");
  });
});

describe("base URL transport security", () => {
  it("stays silent for https endpoints, including the built-in defaults", () => {
    const warnings: string[] = [];
    loadConfig({ env: env(), warn: (m) => warnings.push(m) });
    expect(warnings).toEqual([]);
  });

  it("warns when a provider would send its key over a non-https endpoint", () => {
    const warnings: string[] = [];
    const cfg = loadConfig({
      env: env({ STEPFUN_BASE_URL: "http://insecure.example", STEPFUN_API_KEY: "k" }),
      warn: (m) => warnings.push(m),
    });
    expect(cfg.providers.stepfun.baseUrl).toBe("http://insecure.example");
    expect(warnings.some((w) => w.includes("cleartext"))).toBe(true);
  });

  it("never echoes the configured URL in the warning", () => {
    const warnings: string[] = [];
    loadConfig({ env: env({ STEPFUN_BASE_URL: "http://user:hunter2pass@insecure.example", STEPFUN_API_KEY: "k" }), warn: (m) => warnings.push(m) });
    expect(warnings.join(" ")).not.toContain("hunter2pass");
  });

  it("warns when a base URL has no scheme at all", () => {
    const warnings: string[] = [];
    // ensureV1 only appends /v1; a scheme-less host stays unparseable, and the
    // request will fail later — so the warning is the only signal the user gets.
    const cfg = loadConfig({ env: env({ STEPFUN_BASE_URL: "api.stepfun.example", STEPFUN_API_KEY: "k" }), warn: (m) => warnings.push(m) });
    expect(cfg.providers.stepfun.baseUrl).toBe("api.stepfun.example");
    expect(warnings.some((w) => w.includes("cleartext"))).toBe(true);
  });

  it("stays silent when the non-https slot has no key to leak", () => {
    const warnings: string[] = [];
    loadConfig({ env: env({ STEPFUN_BASE_URL: "http://insecure.example" }), warn: (m) => warnings.push(m) });
    expect(warnings).toEqual([]);
  });
});

describe("config file layer", () => {
  it("reads provider settings and options from the file", () => {
    const cfg = loadConfig({
      env: env(),
      warn: noWarn,
      configFile: "cn-websearch.config.json",
      file: {
        providers: {
          zhipu: {
            apiKey: "z-key",
            baseUrl: "https://z.example/",
            model: "glm-custom",
            enabled: false,
            priority: 9,
            timeoutMs: 12_000,
            options: { searchEngine: "search_pro" },
          },
        },
      },
    });
    expect(cfg.providers.zhipu).toMatchObject({
      apiKey: "z-key",
      baseUrl: "https://z.example",
      model: "glm-custom",
      enabled: false,
      priority: 9,
      timeoutMs: 12_000,
      options: { searchEngine: "search_pro" },
    });
    expect(cfg.configFile).toBe("cn-websearch.config.json");
  });

  it("lets environment variables win over the config file", () => {
    const cfg = loadConfig({
      env: env({ KIMI_API_KEY: "from-env", KIMI_PRIORITY: "7" }),
      warn: noWarn,
      file: { providers: { kimi: { apiKey: "from-file", priority: 1, model: "from-file-model" } } },
    });
    expect(cfg.providers.kimi.apiKey).toBe("from-env");
    expect(cfg.providers.kimi.priority).toBe(7);
    // Fields not overridden by env vars still come from the file.
    expect(cfg.providers.kimi.model).toBe("from-file-model");
  });

  it("lets a per-provider TIMEOUT_MS env value (including 0) override the file", () => {
    const cfg = loadConfig({
      env: env({ KIMI_TIMEOUT_MS: "0", ZHIPU_TIMEOUT_MS: "5000" }),
      warn: noWarn,
      file: { providers: { kimi: { timeoutMs: 9_000 }, zhipu: { timeoutMs: 9_000 } } },
    });
    // 0 is a valid explicit env override meaning "no per-provider budget" (the
    // orchestrator then uses the global one), so the config file value must not
    // win over it; it is normalized to "unset" so nothing reports a 0 ms budget.
    expect(cfg.providers.kimi.timeoutMs).toBeUndefined();
    expect(cfg.providers.zhipu.timeoutMs).toBe(5000);
  });

  it("warns about unknown provider names in the file but keeps going", () => {
    const warnings: string[] = [];
    const cfg = loadConfig({
      env: env(),
      warn: (m) => warnings.push(m),
      file: { providers: { openai: { apiKey: "x" }, kimi: "not-an-object" } },
    });
    expect(warnings.some((w) => w.includes("openai"))).toBe(true);
    expect(cfg.providers.kimi.apiKey).toBe("");
  });

  it("ignores wrongly typed file values instead of failing", () => {
    const cfg = loadConfig({
      env: env(),
      warn: noWarn,
      file: {
        count: "abc",
        timeoutMs: -5,
        maxProviders: 0,
        dedupe: "not-a-bool",
        strategy: "nonsense",
        order: 42,
        providers: { kimi: { apiKey: 42, enabled: "maybe", priority: -1, timeoutMs: "x", options: "nope" } },
      },
    });
    expect(cfg.count).toBe(DEFAULT_COUNT);
    expect(cfg.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(cfg.maxProviders).toBe(DEFAULT_MAX_PROVIDERS);
    expect(cfg.dedupe).toBe(true);
    expect(cfg.strategy).toBe(DEFAULT_STRATEGY);
    expect(cfg.order).toEqual([...KNOWN_PROVIDERS]);
    expect(cfg.providers.kimi.apiKey).toBe("");
    expect(cfg.providers.kimi.enabled).toBe(true);
    expect(cfg.providers.kimi.priority).toBe(0);
    expect(cfg.providers.kimi.timeoutMs).toBeUndefined();
    expect(cfg.providers.kimi.options).toBeUndefined();
  });

  it("supports strategy, count, maxProviders and dedupe from the file", () => {
    const cfg = loadConfig({
      env: env(),
      warn: noWarn,
      file: { strategy: "aggregate", count: 12, maxProviders: 2, dedupe: false },
    });
    expect(cfg).toMatchObject({ strategy: "aggregate", count: 12, maxProviders: 2, dedupe: false });
  });

  it("maps the legacy ZHIPU_SEARCH_ENGINE env var into provider options", () => {
    const cfg = loadConfig({ env: env({ ZHIPU_SEARCH_ENGINE: "search_pro_quark" }), warn: noWarn });
    expect(cfg.providers.zhipu.options).toEqual({ searchEngine: "search_pro_quark" });
  });
});

describe("order and priority resolution", () => {
  it("honours an explicit order in the config file", () => {
    const cfg = loadConfig({ env: env(), warn: noWarn, file: { order: ["zhipu", "kimi"] } });
    expect(cfg.order).toEqual(["zhipu", "kimi"]);
  });

  it("lets WEBSEARCH_ORDER win over the file order", () => {
    const cfg = loadConfig({
      env: env({ WEBSEARCH_ORDER: "mimo" }),
      warn: noWarn,
      file: { order: ["zhipu", "kimi"] },
    });
    expect(cfg.order).toEqual(["mimo"]);
  });

  it("derives the order from priority when no explicit order is given", () => {
    const cfg = loadConfig({
      env: env({ STEPFUN_PRIORITY: "10", KIMI_PRIORITY: "1", ZHIPU_PRIORITY: "5" }),
      warn: noWarn,
    });
    expect(cfg.order).toEqual(["stepfun", "zhipu", "kimi", "mimo"]);
  });

  it("breaks priority ties alphabetically for determinism", () => {
    const cfg = loadConfig({ env: env({ ZHIPU_PRIORITY: "3", STEPFUN_PRIORITY: "3" }), warn: noWarn });
    expect(cfg.order).toEqual(["stepfun", "zhipu", "kimi", "mimo"]);
  });

  it("reads priority from the config file too", () => {
    const cfg = loadConfig({
      env: env(),
      warn: noWarn,
      file: { providers: { kimi: { priority: 8 }, stepfun: { priority: 2 } } },
    });
    expect(cfg.order).toEqual(["kimi", "stepfun", "mimo", "zhipu"]);
  });
});

describe("parseProviderList", () => {
  it("parses comma strings and arrays, deduping and preserving order", () => {
    expect(parseProviderList("zhipu, stepfun ,zhipu", noWarn, "test")).toEqual(["zhipu", "stepfun"]);
    expect(parseProviderList(["mimo", "KIMI"], noWarn, "test")).toEqual(["mimo", "kimi"]);
  });

  it("ignores unknown names with a warning and tolerates other types", () => {
    const warnings: string[] = [];
    expect(parseProviderList("zhipu,openai", (m) => warnings.push(m), "WEBSEARCH_ORDER")).toEqual(["zhipu"]);
    expect(warnings[0]).toContain("openai");
    expect(parseProviderList(undefined, noWarn, "test")).toEqual([]);
    expect(parseProviderList(42, noWarn, "test")).toEqual([]);
    expect(parseProviderList([1, null, "kimi"], noWarn, "test")).toEqual(["kimi"]);
  });
});

describe("parseStrategy", () => {
  it("accepts the two known strategies case-insensitively", () => {
    expect(parseStrategy("fallback", noWarn, "t")).toBe("fallback");
    expect(parseStrategy("AGGREGATE", noWarn, "t")).toBe("aggregate");
  });

  it("returns undefined for absent values and warns for unknown ones", () => {
    expect(parseStrategy(undefined, noWarn, "t")).toBeUndefined();
    expect(parseStrategy("", noWarn, "t")).toBeUndefined();
    const warnings: string[] = [];
    expect(parseStrategy("nope", (m) => warnings.push(m), "WEBSEARCH_STRATEGY")).toBeUndefined();
    expect(warnings[0]).toContain("fallback|aggregate");
    expect(parseStrategy(42, noWarn, "t")).toBeUndefined();
  });
});

describe("gateway-level env settings", () => {
  it("reads strategy, timeout, count, maxProviders and dedupe from env", () => {
    const cfg = loadConfig({
      env: env({
        WEBSEARCH_STRATEGY: "aggregate",
        WEBSEARCH_TIMEOUT_MS: "45000",
        WEBSEARCH_COUNT: "3",
        WEBSEARCH_MAX_PROVIDERS: "2",
        WEBSEARCH_DEDUPE: "off",
      }),
      warn: noWarn,
    });
    expect(cfg).toMatchObject({
      strategy: "aggregate",
      timeoutMs: 45_000,
      count: 3,
      maxProviders: 2,
      dedupe: false,
    });
  });

  it("warns and falls back on garbage numeric values", () => {
    const warnings: string[] = [];
    const cfg = loadConfig({
      env: env({ WEBSEARCH_TIMEOUT_MS: "abc", WEBSEARCH_COUNT: "0", WEBSEARCH_MAX_PROVIDERS: "-2" }),
      warn: (m) => warnings.push(m),
    });
    expect(cfg.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(cfg.count).toBe(DEFAULT_COUNT);
    expect(cfg.maxProviders).toBe(DEFAULT_MAX_PROVIDERS);
    expect(warnings.length).toBe(3);
  });

  it("clamps count to the tool schema maximum", () => {
    expect(loadConfig({ env: env({ WEBSEARCH_COUNT: "999" }), warn: noWarn }).count).toBe(50);
  });

  it("accepts every documented boolean spelling", () => {
    for (const raw of ["1", "true", "yes", "on", "TRUE"]) {
      expect(loadConfig({ env: env({ WEBSEARCH_DEDUPE: raw }), warn: noWarn }).dedupe).toBe(true);
    }
    for (const raw of ["0", "false", "no", "off", "OFF"]) {
      expect(loadConfig({ env: env({ WEBSEARCH_DEDUPE: raw }), warn: noWarn }).dedupe).toBe(false);
    }
    expect(loadConfig({ env: env({ KIMI_ENABLED: "off" }), warn: noWarn }).providers.kimi.enabled).toBe(false);
    // Unrecognized spellings fall back to the default instead of being treated as false.
    expect(loadConfig({ env: env({ KIMI_ENABLED: "maybe" }), warn: noWarn }).providers.kimi.enabled).toBe(true);
  });

  it("warns on stderr when no custom warn callback is provided", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(loadConfig({ env: env({ WEBSEARCH_TIMEOUT_MS: "abc" }) }).timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(errSpy).toHaveBeenCalledOnce();
    errSpy.mockRestore();
  });
});
