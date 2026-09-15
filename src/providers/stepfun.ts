/**
 * @file providers/stepfun
 * @description StepFun adapter: the dedicated Search REST API.
 *
 * Responsibilities:
 * - POST {base}/v1/search with body { query, n } (docs checked on 2026-09-15)
 * - Map results[] entries {url,title,time,snippet,content} to normalized items
 * - Clamp n to the documented 1..20 range; keep the protocol layer thin
 * - Configurable options: category
 */

// StepFun adapter: the dedicated Search REST API.
//
// Basis (checked on 2026-09-15):
//   https://platform.stepfun.com/docs/zh/api-reference/search/search
//   POST {base}/v1/search, Bearer auth.
//   Request: { query, n /* 1..20, default 10 */, category? }
//   Response: { results: [{ url, position, title, time, snippet, content }] }
//   Here `content` is the page's full text — consistent with the known
//   "structured results + full text" behavior.
//
// The StepSearch MCP endpoint used by the early shim (step_plan/v1/mcp/web_search/mcp)
// also works, but the REST API is simpler and returns structured fields directly. web_fetch
// and chat-embedded web_search are deliberately not used (the chat channel returns a text
// placeholder; fetch has a known 30-second timeout issue, and both are out of scope for v0.1).

import { asArray, asObject, clampInt, str, toItem } from "../normalize.js";
import { postJson } from "../http.js";
import type { NormalizedSearchResult, SearchContext, SearchProvider, SearchRequest } from "../types.js";
import type { ProviderConfig } from "../config.js";

export function createStepfunProvider(cfg: ProviderConfig): SearchProvider {
  return {
    name: "stepfun",
    timeoutMs: cfg.timeoutMs,
    isConfigured: () => cfg.apiKey.trim() !== "",
    async search(req: SearchRequest, ctx: SearchContext): Promise<NormalizedSearchResult> {
      const category = str(cfg.options?.category).trim();
      const payload = {
        query: req.query,
        n: clampInt(req.count, 10, 1, 20),
        ...(category ? { category } : {}),
      };
      const res = await postJson(
        `${cfg.baseUrl}/v1/search`,
        payload,
        // The API docs require an explicit charset declaration.
        { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json; charset=utf-8" },
        { timeoutMs: ctx.timeoutMs, signal: ctx.signal, fetchImpl: ctx.fetchImpl },
      );
      const body = asObject(res.json, "stepfun response");
      const hits = asArray(body.results, "stepfun results");
      // A malformed single hit affects only that hit: degrade to an empty object and let toItem decide.
      const results = hits
        .map((h) => {
          const o = (h && typeof h === "object" ? h : {}) as Record<string, unknown>;
          return toItem({
            title: o.title,
            url: o.url,
            snippet: str(o.snippet),
            content: str(o.content) || undefined,
            published_date: o.time,
          });
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .slice(0, req.count);
      return { results, _meta: { provider: "stepfun", total_latency_ms: 0, attempts: [] } };
    },
  };
}
