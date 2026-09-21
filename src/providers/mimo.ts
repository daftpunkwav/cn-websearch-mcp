/**
 * @file providers/mimo
 * @description Xiaomi MiMo adapter: web_search over OpenAI chat completions.
 *
 * Responsibilities:
 * - Send the request shape verified against the private reference (tools[0].type=web_search, limit=count)
 * - Merge url_citation titles and web_search_highlight snippets by URL
 * - Expose the LLM's synthesized answer via _meta.answer
 * - Configurable options: location, maxKeyword, forceSearch
 */

// Xiaomi MiMo adapter: server-side web_search over OpenAI chat completions.
//
// Ported from a verified private reference implementation (validated live in 2026-08).
// MiMo offers web search only on the OpenAI chat completions format
// (neither responses nor the anthropic gateway supports it). The response is the LLM's
// synthesized answer plus structured references in message.annotations:
//   { type: "url_citation", title, url }
//   { type: "web_search_highlight", title /* highlighted text */, url }
//
// Location parameters always come from config (no built-in fixed city anymore); when unset, only the country level is given.

import { hostnameOf, asObject, asArray, clampInt, maybeObject, str, toItem } from "../normalize.js";
import { postJson } from "../http.js";
import type { NormalizedItem, NormalizedSearchResult, SearchContext, SearchProvider, SearchRequest } from "../types.js";
import type { ProviderConfig } from "../config.js";

interface Annotation {
  type?: unknown;
  title?: unknown;
  url?: unknown;
}

/** Merges url_citation (title) and web_search_highlight (snippet) entries by URL. */
function itemsFromAnnotations(annotations: unknown[]): NormalizedItem[] {
  const byUrl = new Map<string, NormalizedItem>();
  for (const raw of annotations) {
    const a = raw as Annotation;
    const url = str(a.url).trim();
    if (!url) continue;
    const urlNorm = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const kind = str(a.type);
    const title = str(a.title).trim();
    const existing = byUrl.get(urlNorm);
    if (kind === "url_citation") {
      if (existing) {
        if (title && !existing.title) existing.title = title;
      } else {
        byUrl.set(urlNorm, { title: title || hostnameOf(urlNorm), url: urlNorm, snippet: "" });
      }
    } else if (kind === "web_search_highlight") {
      if (existing) {
        if (!existing.snippet && title) existing.snippet = title;
      } else if (title) {
        byUrl.set(urlNorm, { title: hostnameOf(urlNorm), url: urlNorm, snippet: title });
      }
    }
  }
  return [...byUrl.values()];
}

/**
 * Assemble the user_location parameter. Fill only the levels explicitly given in config; the
 * open-source adapter deliberately does not guess a city when unset.
 */
function userLocation(options: Record<string, unknown> | undefined): Record<string, unknown> {
  const loc = maybeObject(options?.location);
  const out: Record<string, unknown> = { type: "approximate" };
  const country = str(loc?.country).trim() || "China";
  out.country = country;
  for (const key of ["region", "city"] as const) {
    const value = str(loc?.[key]).trim();
    if (value) out[key] = value;
  }
  return out;
}

export function createMimoProvider(cfg: ProviderConfig): SearchProvider {
  return {
    name: "mimo",
    timeoutMs: cfg.timeoutMs,
    isConfigured: () => cfg.apiKey.trim() !== "",
    async search(req: SearchRequest, ctx: SearchContext): Promise<NormalizedSearchResult> {
      const options = cfg.options;
      // `limit` (max result pages) is the channel's closest knob to `count`; the historical shim
      // defaulted it to 1. This is a mapping assumption that should be revisited if the upstream
      // semantics change.
      const limit = clampInt(req.count, 1, 1, 10);
      const payload = {
        model: cfg.model ?? "mimo-v2.5",
        messages: [{ role: "user", content: req.query }],
        max_completion_tokens: 2048,
        stream: false,
        extra_body: { thinking: { type: "disabled" } },
        tools: [
          {
            type: "web_search",
            max_keyword: clampInt(options?.maxKeyword, 3, 1, 10),
            force_search: options?.forceSearch !== false,
            limit,
            user_location: userLocation(options),
          },
        ],
        tool_choice: "auto",
      };
      const res = await postJson(
        `${cfg.baseUrl}/chat/completions`,
        payload,
        { Authorization: `Bearer ${cfg.apiKey}` },
        { timeoutMs: ctx.timeoutMs, signal: ctx.signal, fetchImpl: ctx.fetchImpl },
      );
      const body = asObject(res.json, "mimo response");
      const choices = asArray(body.choices, "mimo choices");
      const choice = asObject(choices[0] ?? null, "mimo choice");
      const message = asObject(choice.message ?? null, "mimo message");
      const answer = str(message.content).trim();
      // Treat missing or non-array annotations as empty: the answer still works, just without references.
      const annotations = Array.isArray(message.annotations) ? (message.annotations as unknown[]) : [];
      const results = itemsFromAnnotations(annotations).slice(0, req.count);
      return {
        results,
        _meta: { provider: "mimo", total_latency_ms: 0, attempts: [], answer: answer || undefined },
      };
    },
  };
}
