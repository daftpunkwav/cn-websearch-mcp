/**
 * @file tools
 * @description MCP tool layer: tool definitions, argument validation and dispatch.
 *
 * Responsibilities:
 * - Expose two tools: web_search (with strategy and provider selection) and provider_status
 * - Validate and normalize tool arguments before the orchestrator runs
 * - Format successful results and structured failures as MCP text content
 * - All dependencies are injected via deps; this module never reads the environment or builds providers itself
 */

// MCP tool layer. Upward it depends only on the injected deps object; downward
// it only knows the SearchProvider interface and the orchestration entry — no
// concrete provider adapter implementation (provider_status only does a
// read-only enumeration over the name list exported by the registry), keeping
// the layers decoupled.

import { KNOWN_PROVIDERS, type GatewayConfig } from "./config.js";
import { AllProvidersFailedError, runSearch, type DispatchOptions } from "./orchestrator.js";
import { clampInt, truncate } from "./normalize.js";
import { SERVER_NAME } from "./server-info.js";
import type { AttemptRecord, NormalizedSearchResult, SearchProvider, SearchRequest, SearchStrategy } from "./types.js";

const STRATEGIES: readonly SearchStrategy[] = ["fallback", "aggregate"];
const COUNT_MIN = 1;
const COUNT_MAX = 50;
const QUERY_MAX = 400;

export interface ToolOutput {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Search execution function signature (runSearch by default; injectable for tests). */
export type SearchFn = (req: SearchRequest, opts: DispatchOptions) => Promise<NormalizedSearchResult>;

/** Dependencies injected by the entry (keeps this module independently testable). */
export interface GatewayToolsDeps {
  /** Effective config (strategy, timeout, default result count, provider switches and priorities). */
  config: GatewayConfig;
  /** Adapters that can actually search, in priority order. */
  chain: SearchProvider[];
  /** Search implementation; defaults to the orchestrator's runSearch. */
  searchFn?: SearchFn;
}

/** Wrap any payload as a single JSON text content (flagged when isError is true). */
export function textContent(payload: unknown, isError = false): ToolOutput {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Build the tool definitions. The default result count comes from config, so
 * the schema's default always matches actual behavior (no more hard-coded 8).
 */
export function buildToolDefinitions(defaultCount: number, defaultStrategy: SearchStrategy) {
  return [
    {
      name: "web_search",
      description:
        "Search the web through any of the configured built-in search channels. " +
        "Two strategies: 'fallback' tries slots in your configured priority order and returns the first success; " +
        "'aggregate' queries several slots in parallel and merges the results (deduplicated by URL, each item tagged " +
        "with its source slot). Per-attempt timeout, one retry on transient failures. Returns normalized results " +
        "{ title, url, snippet, content?, published_date?, source? } plus _meta with the answering slot(s), " +
        "total latency, and a per-attempt audit trail.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
          count: {
            type: "integer",
            minimum: COUNT_MIN,
            maximum: COUNT_MAX,
            default: defaultCount,
            description: "Desired number of results (clamped per provider limits)",
          },
          strategy: {
            type: "string",
            enum: STRATEGIES,
            default: defaultStrategy,
            description:
              "'fallback' = first provider that answers wins; 'aggregate' = query several providers and merge. " +
              "Defaults to the configured strategy.",
          },
          providers: {
            type: "array",
            items: { type: "string", enum: KNOWN_PROVIDERS },
            description:
              "Optional subset of providers to use for this call, in priority order. " +
              "Only providers that are enabled and have an API key can be selected.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "provider_status",
      description:
        "Read-only status: effective strategy and settings, plus which providers are enabled, have API keys and " +
        "are part of the active search chain.",
      inputSchema: { type: "object", properties: {} },
    },
  ] as const;
}

/** Provider selection result: adapters on success, or an error ready to return to the caller on failure. */
type ProviderSelection = { ok: true; providers: SearchProvider[] } | { ok: false; error: string };

/**
 * Filter usable adapters by a requested name subset. Fails explicitly instead
 * of silently ignoring: the caller named specific providers, so an unmet
 * request must be reported back.
 */
function selectProviders(requested: unknown, chain: SearchProvider[]): ProviderSelection {
  if (requested === undefined) return { ok: true, providers: chain };
  if (!Array.isArray(requested) || requested.some((x) => typeof x !== "string")) {
    return { ok: false, error: "invalid arguments: 'providers' must be an array of provider names" };
  }
  const names = [...new Set(requested.map((x) => x.trim().toLowerCase()).filter((x) => x !== ""))];
  if (!names.length) return { ok: false, error: "invalid arguments: 'providers' must not be empty" };

  const unknown = names.filter((n) => !(KNOWN_PROVIDERS as readonly string[]).includes(n));
  if (unknown.length) {
    return {
      ok: false,
      error: `unknown provider(s): ${unknown.join(", ")} (known: ${KNOWN_PROVIDERS.join(", ")})`,
    };
  }
  const byName = new Map(chain.map((p) => [p.name, p]));
  const unavailable = names.filter((n) => !byName.has(n));
  if (unavailable.length) {
    return {
      ok: false,
      error: `provider(s) unavailable: ${unavailable.join(", ")} (disabled or missing API key)`,
    };
  }
  return { ok: true, providers: names.map((n) => byName.get(n)!) };
}

/** Validate the strategy argument: falls back to the configured default when not provided. */
function selectStrategy(requested: unknown, fallback: SearchStrategy): SearchStrategy | "invalid" {
  if (requested === undefined) return fallback;
  const value = typeof requested === "string" ? (requested.trim().toLowerCase() as SearchStrategy) : "invalid";
  return (STRATEGIES as readonly string[]).includes(value) ? value : "invalid";
}

export function createGatewayTools(deps: GatewayToolsDeps) {
  const { config } = deps;
  const chainNames = new Set(deps.chain.map((p) => p.name));
  const searchFn: SearchFn = deps.searchFn ?? runSearch;

  /** Read-only status: config plus each provider's enabled/key/in-chain state (keys are never echoed). */
  function providerStatus() {
    return {
      strategy: config.strategy,
      order: config.order,
      timeout_ms: config.timeoutMs,
      count: config.count,
      max_providers: config.maxProviders,
      dedupe: config.dedupe,
      config_file: config.configFile ?? null,
      providers: KNOWN_PROVIDERS.map((name) => {
        const p = config.providers[name];
        return {
          name,
          enabled: p.enabled,
          configured: p.apiKey.trim() !== "",
          in_chain: chainNames.has(name),
          priority: p.priority,
          model: p.model ?? null,
          timeout_ms: p.timeoutMs ?? null,
        };
      }),
    };
  }

  /** Dispatch one tools/call request; structured error for unknown tools. */
  async function call(name: string, args: Record<string, unknown>): Promise<ToolOutput> {
    if (name === "provider_status") {
      return textContent(providerStatus());
    }

    if (name === "web_search") {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        return textContent({ error: "invalid arguments: 'query' must be a non-empty string" }, true);
      }
      const count =
        args.count === undefined ? config.count : clampInt(args.count, config.count, COUNT_MIN, COUNT_MAX);
      const strategy = selectStrategy(args.strategy, config.strategy);
      if (strategy === "invalid") {
        return textContent(
          { error: `invalid arguments: 'strategy' must be one of ${STRATEGIES.join(", ")}` },
          true,
        );
      }
      const selection = selectProviders(args.providers, deps.chain);
      if (!selection.ok) {
        return textContent({ error: selection.error }, true);
      }

      try {
        const out = await searchFn({ query: truncate(query, QUERY_MAX), count }, {
          providers: selection.providers,
          timeoutMs: config.timeoutMs,
          maxProviders: config.maxProviders,
          dedupe: config.dedupe,
          strategy,
        });
        return textContent(out);
      } catch (err) {
        // All providers failing is an expected business failure: return the audit trail to the caller as-is.
        if (err instanceof AllProvidersFailedError) {
          return textContent({ error: err.message, attempts: err.attempts }, true);
        }
        // Any other exception is unexpected: log the full error to stderr, return only a safe summary.
        console.error(`[${SERVER_NAME}] unexpected error:`, err);
        return textContent(
          {
            error: err instanceof Error ? err.message : String(err),
            attempts: [] as AttemptRecord[],
          },
          true,
        );
      }
    }

    return textContent({ error: `unknown tool: ${name}` }, true);
  }

  return { list: () => buildToolDefinitions(config.count, config.strategy), call };
}
