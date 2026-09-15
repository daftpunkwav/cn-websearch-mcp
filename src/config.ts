/**
 * @file config
 * @description Gateway configuration resolution: built-in defaults → config file → environment variables, each layer overriding the last.
 *
 * Responsibilities:
 * - Provide neutral per-provider defaults (base URL, model) with nothing personal baked in
 * - Parse fallback order/priority, strategy, timeout, result count and other settings from the config file and environment variables
 * - Validate each layer's input leniently: invalid values warn and fall back, never throwing
 *
 * Design notes:
 * - The default order is alphabetical — not a "recommended order"; custom priority is always explicit user configuration
 * - A provider's environment variable names are derived from its name (`<NAME>_API_KEY` etc.),
 *   so adding a provider requires no changes to the parsing branches in this file
 * - This module is pure: it never reads the disk (config file content is passed in by the caller), which keeps it easy to test
 */

// Configuration resolution layer. Precedence: built-in defaults < config file < environment variables.
// MCP clients can usually only pass environment variables, so env sits at the top layer.

import type { ConfigFileShape } from "./config-file.js";
import { maybeObject } from "./normalize.js";
import type { SearchStrategy } from "./types.js";

/**
 * All supported providers, in alphabetical order.
 * This order doubles as the default priority order — deliberately neutral, with no vendor preference baked in.
 */
export const KNOWN_PROVIDERS = ["kimi", "mimo", "stepfun", "zhipu"] as const;
export type ProviderName = (typeof KNOWN_PROVIDERS)[number];

export const DEFAULT_ORDER: ProviderName[] = [...KNOWN_PROVIDERS];
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_COUNT = 8;
export const DEFAULT_MAX_PROVIDERS = KNOWN_PROVIDERS.length;
export const DEFAULT_STRATEGY: SearchStrategy = "fallback";

const STRATEGIES: readonly SearchStrategy[] = ["fallback", "aggregate"];
const COUNT_MAX = 50;
const MAX_PROVIDERS_MIN = 1;

/** Neutral per-provider defaults (no keys, no personalized parameters). */
interface ProviderDefaults {
  baseUrl: string;
  model?: string;
  /** Whether to use the OpenAI-compatible protocol (requires a /v1 root path). */
  openAiCompatible?: boolean;
}

const PROVIDER_DEFAULTS: Record<ProviderName, ProviderDefaults> = {
  kimi: { baseUrl: "https://api.moonshot.cn", model: "kimi-k3", openAiCompatible: true },
  mimo: { baseUrl: "https://token-plan-cn.xiaomimimo.com", model: "mimo-v2.5", openAiCompatible: true },
  stepfun: { baseUrl: "https://api.stepfun.com" },
  zhipu: { baseUrl: "https://open.bigmodel.cn" },
};

export interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  model?: string;
  /** Config-level switch: when false, the provider takes part in no search. */
  enabled: boolean;
  /** Priority: higher comes first; when all are 0 (the default), alphabetical by name. */
  priority: number;
  /** Per-provider timeout budget (ms); falls back to the global timeoutMs when unset. */
  timeoutMs?: number;
  /** Provider-specific optional parameters (validated and consumed by each adapter). */
  options?: Record<string, unknown>;
}

export interface GatewayConfig {
  /** Effective provider order (order/priority configuration applied). */
  order: ProviderName[];
  /** Default search strategy. */
  strategy: SearchStrategy;
  /** Wall-clock budget for a single attempt (ms). */
  timeoutMs: number;
  /** Result count the MCP tool uses when a call omits count. */
  count: number;
  /** Maximum number of providers used per call (fallback chain length cap). */
  maxProviders: number;
  /** Whether aggregated results are deduplicated by URL. */
  dedupe: boolean;
  providers: Record<ProviderName, ProviderConfig>;
  /** Path of the loaded config file (for diagnostics; empty when no file is used). */
  configFile?: string;
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/**
 * Kimi/MiMo use the OpenAI-compatible protocol, rooted at /v1. Both the
 * bare-host and the /v1-suffixed forms are accepted, so either convention works.
 */
function ensureV1(baseUrl: string): string {
  const b = trimSlash(baseUrl);
  return b.endsWith("/v1") ? b : b + "/v1";
}

/** Derive a provider's environment variable name, e.g. kimi + "API_KEY" -> KIMI_API_KEY. */
export function providerEnvKey(name: ProviderName, suffix: string): string {
  return `${name.toUpperCase()}_${suffix}`;
}

/** Lenient string getter; returns undefined for non-strings (distinguishing "unset" from "set to empty"). */
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Lenient boolean getter: accepts booleans and on/off/yes/no/true/false/1/0 strings. */
function asBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
    if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  }
  return undefined;
}

/** Lenient non-negative integer getter (0 is valid, used for priority). */
function asNonNegativeInt(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}

/** Lenient getter for obj.key as a string. */
function strField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  return obj ? asString(obj[key]) : undefined;
}

/** Lenient getter for obj.key as a boolean. */
function boolField(obj: Record<string, unknown> | undefined, key: string): boolean | undefined {
  return obj ? asBool(obj[key]) : undefined;
}

/** Lenient getter for obj.key as a non-negative integer. */
function intField(obj: Record<string, unknown> | undefined, key: string): number | undefined {
  return obj ? asNonNegativeInt(obj[key]) : undefined;
}

/** Read obj.key as a positive integer; undefined when missing or invalid (for optional overrides). */
function optionalPositiveInt(obj: Record<string, unknown> | undefined, key: string): number | undefined {
  const raw = obj?.[key];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Read the providers.<name> sub-object from the config file; undefined on type mismatch. */
function providerEntry(file: ConfigFileShape | undefined, name: ProviderName): Record<string, unknown> | undefined {
  const providers = file?.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return undefined;
  const entry = (providers as Record<string, unknown>)[name];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  return entry as Record<string, unknown>;
}

/** Read the top-level providers object from the config file, filtering out non-object values. */
function providerEntries(file: ConfigFileShape | undefined): Record<string, unknown> {
  const providers = file?.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(providers as Record<string, unknown>)) {
    if (value && typeof value === "object" && !Array.isArray(value)) out[key] = value;
  }
  return out;
}

/**
 * Parse a provider name list: accepts either an "a,b" string (env-friendly)
 * or an array (config-file-friendly). Unknown names warn and are ignored;
 * duplicates are removed while preserving first-occurrence order.
 */
export function parseProviderList(
  raw: unknown,
  warn: (m: string) => void,
  source: string,
): ProviderName[] {
  const parts: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const seen = new Set<ProviderName>();
  for (const part of parts) {
    const name = (typeof part === "string" ? part : "").trim().toLowerCase();
    if (name === "") continue;
    if ((KNOWN_PROVIDERS as readonly string[]).includes(name)) seen.add(name as ProviderName);
    else warn(`${source}: unknown provider "${name}" ignored`);
  }
  return [...seen];
}

/** Parse a strategy name; undefined when missing, warn-and-return-undefined when invalid. */
export function parseStrategy(raw: unknown, warn: (m: string) => void, source: string): SearchStrategy | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if ((STRATEGIES as readonly string[]).includes(s)) return s as SearchStrategy;
  warn(`${source}: unknown strategy "${String(raw)}", expected ${STRATEGIES.join("|")}`);
  return undefined;
}

/** Parse a positive integer; return the fallback when missing or invalid (with a warning). */
function positiveInt(raw: unknown, fallback: number, source: string, warn: (m: string) => void): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    warn(`${source}="${String(raw)}" is not a positive integer, using ${fallback}`);
    return fallback;
  }
  return n;
}

/**
 * Compute the effective order, highest precedence first:
 * 1. Explicit order (env WEBSEARCH_ORDER > config file order)
 * 2. priority from the config file / per-provider env (descending; ties broken alphabetically)
 * 3. Default alphabetical order (neutral, no vendor preference)
 */
function resolveOrder(
  env: NodeJS.ProcessEnv,
  file: ConfigFileShape | undefined,
  providers: Record<ProviderName, ProviderConfig>,
  warn: (m: string) => void,
): ProviderName[] {
  const envOrder = parseProviderList(env.WEBSEARCH_ORDER, warn, "WEBSEARCH_ORDER");
  if (envOrder.length) return envOrder;
  const fileOrder = parseProviderList(file?.order, warn, "config order");
  if (fileOrder.length) return fileOrder;
  if (KNOWN_PROVIDERS.some((name) => providers[name].priority > 0)) {
    return [...KNOWN_PROVIDERS].sort(
      (a, b) => providers[b].priority - providers[a].priority || a.localeCompare(b),
    );
  }
  return [...DEFAULT_ORDER];
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  warn?: (m: string) => void;
  /** Parsed config file content; read by runtime — this module never touches the disk. */
  file?: ConfigFileShape;
  /** Config file path, for diagnostic output only (never read). */
  configFile?: string;
}

const defaultWarn = (m: string): void => console.error(`[cn-websearch-mcp] ${m}`);

/**
 * Merge the three config layers into the final GatewayConfig.
 * Invalid values at any layer only warn and fall back, so this function never throws in any environment.
 */
export function loadConfig(options: LoadConfigOptions = {}): GatewayConfig {
  const env = options.env ?? process.env;
  const warn = options.warn ?? defaultWarn;
  const file = options.file;

  // Warn about unknown provider names in the config file (usually typos).
  const entries = providerEntries(file);
  for (const key of Object.keys(entries)) {
    if (!(KNOWN_PROVIDERS as readonly string[]).includes(key)) {
      warn(`config providers: unknown provider "${key}" ignored`);
    }
  }

  const providers = {} as Record<ProviderName, ProviderConfig>;
  for (const name of KNOWN_PROVIDERS) {
    const defaults = PROVIDER_DEFAULTS[name];
    const entry = providerEntry(file, name);

    const rawBase = env[providerEnvKey(name, "BASE_URL")] ?? strField(entry, "baseUrl") ?? defaults.baseUrl;
    const baseUrl = defaults.openAiCompatible ? ensureV1(rawBase) : trimSlash(rawBase);

    // zhipu's searchEngine was historically exposed via an environment variable; kept for backward compatibility.
    const providerOptions: Record<string, unknown> = { ...maybeObject(entry?.options) };
    if (name === "zhipu") {
      const envEngine = (env.ZHIPU_SEARCH_ENGINE ?? "").trim();
      if (envEngine) providerOptions.searchEngine = envEngine;
    }

    providers[name] = {
      apiKey: env[providerEnvKey(name, "API_KEY")] ?? strField(entry, "apiKey") ?? "",
      baseUrl,
      model: (env[providerEnvKey(name, "MODEL")] ?? "").trim() || strField(entry, "model") || defaults.model,
      enabled: asBool(env[providerEnvKey(name, "ENABLED")]) ?? boolField(entry, "enabled") ?? true,
      priority: asNonNegativeInt(env[providerEnvKey(name, "PRIORITY")]) ?? intField(entry, "priority") ?? 0,
      timeoutMs:
        asNonNegativeInt(env[providerEnvKey(name, "TIMEOUT_MS")]) || optionalPositiveInt(entry, "timeoutMs"),
      options: Object.keys(providerOptions).length ? providerOptions : undefined,
    };
  }

  const timeoutMs = positiveInt(
    env.WEBSEARCH_TIMEOUT_MS ?? file?.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    "WEBSEARCH_TIMEOUT_MS",
    warn,
  );
  const count = Math.min(
    COUNT_MAX,
    positiveInt(env.WEBSEARCH_COUNT ?? file?.count, DEFAULT_COUNT, "WEBSEARCH_COUNT", warn),
  );
  const maxProviders = Math.max(
    MAX_PROVIDERS_MIN,
    positiveInt(
      env.WEBSEARCH_MAX_PROVIDERS ?? file?.maxProviders,
      DEFAULT_MAX_PROVIDERS,
      "WEBSEARCH_MAX_PROVIDERS",
      warn,
    ),
  );

  return {
    order: resolveOrder(env, file, providers, warn),
    strategy:
      parseStrategy(env.WEBSEARCH_STRATEGY, warn, "WEBSEARCH_STRATEGY") ??
      parseStrategy(file?.strategy, warn, "config strategy") ??
      DEFAULT_STRATEGY,
    timeoutMs,
    count,
    maxProviders,
    dedupe: asBool(env.WEBSEARCH_DEDUPE) ?? asBool(file?.dedupe) ?? true,
    providers,
    configFile: options.configFile,
  };
}
