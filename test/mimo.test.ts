/**
 * @file test/mimo
 * @description MiMo adapter unit tests: request construction, citation merging, limit clamping and error paths.
 */

import { describe, expect, it } from "vitest";
import { createMimoProvider } from "../src/providers/mimo.js";
import type { FetchLike, SearchContext } from "../src/types.js";

const ctx = (fetchImpl: FetchLike): SearchContext => ({
  timeoutMs: 5_000,
  signal: new AbortController().signal,
  fetchImpl,
});

const cfg = { apiKey: "test-key", baseUrl: "https://mimo.example/v1", model: "mimo-test" };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

describe("mimo provider", () => {
  it("isConfigured reflects key presence", () => {
    expect(createMimoProvider(cfg).isConfigured()).toBe(true);
    expect(createMimoProvider({ ...cfg, apiKey: "" }).isConfigured()).toBe(false);
  });

  it("builds the shim-verified request and merges citations with highlights", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init: init! });
      return jsonResponse({
        choices: [{ message: { content: "综合答案", annotations: [
          { type: "url_citation", title: "新闻 A", url: "https://a.example/1" },
          { type: "web_search_highlight", title: "高亮片段", url: "https://a.example/1" },
          { type: "url_citation", title: "", url: "b.example/2" },
        ] } }],
      });
    };
    const out = await createMimoProvider(cfg).search({ query: "q", count: 8 }, ctx(fetchImpl));
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(calls[0]!.url).toBe("https://mimo.example/v1/chat/completions");
    expect(body.tools[0].type).toBe("web_search");
    expect(body.tools[0].limit).toBe(8);
    expect(body.tools[0].force_search).toBe(true);
    expect(body.model).toBe("mimo-test");
    expect(out._meta.provider).toBe("mimo");
    expect(out._meta.answer).toBe("综合答案");
    expect(out.results).toEqual([
      { title: "新闻 A", url: "https://a.example/1", snippet: "高亮片段" },
      { title: "b.example", url: "https://b.example/2", snippet: "" },
    ]);
  });

  it("maps count to limit clamped to 1..10", async () => {
    const limits: number[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      limits.push(JSON.parse(init!.body as string).tools[0].limit);
      return jsonResponse({ choices: [{ message: { content: "", annotations: [] } }] });
    };
    const p = createMimoProvider(cfg);
    await p.search({ query: "q", count: 50 }, ctx(fetchImpl));
    await p.search({ query: "q", count: 0 }, ctx(fetchImpl));
    expect(limits).toEqual([10, 1]);
  });

  it("merges duplicate citations and highlight-only annotations by URL", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        choices: [{ message: { content: "答案", annotations: [
          { type: "url_citation", title: "第一标题", url: "https://dup.example/1" },
          { type: "url_citation", title: "第二标题", url: "https://dup.example/1" },
          { type: "url_citation", title: "有空格", url: "  https://space.example/2  " },
          { type: "url_citation", title: "no url", url: "" },
          { type: "web_search_highlight", title: "补充摘要", url: "https://dup.example/1" },
          { type: "web_search_highlight", title: "仅高亮", url: "https://only.example/3" },
          { type: "unknown_type", title: "t", url: "https://x.example/4" },
        ] } }],
      });
    const out = await createMimoProvider(cfg).search({ query: "q", count: 8 }, ctx(fetchImpl));
    expect(out.results).toEqual([
      { title: "第一标题", url: "https://dup.example/1", snippet: "补充摘要" },
      { title: "有空格", url: "https://space.example/2", snippet: "" },
      { title: "only.example", url: "https://only.example/3", snippet: "仅高亮" },
    ]);
    expect(out._meta.answer).toBe("答案");
  });

  it("keeps answerless replies and empty annotations as a successful empty result", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ choices: [{ message: { content: "", annotations: [] } }] });
    const out = await createMimoProvider(cfg).search({ query: "q", count: 8 }, ctx(fetchImpl));
    expect(out.results).toEqual([]);
    expect(out._meta.answer).toBeUndefined();
  });

  it("tolerates a missing annotations array", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ choices: [{ message: { content: "only text" } }] });
    const out = await createMimoProvider(cfg).search({ query: "q", count: 8 }, ctx(fetchImpl));
    expect(out.results).toEqual([]);
    expect(out._meta.answer).toBe("only text");
  });

  it("throws ParseError when choices is empty", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ choices: [] });
    await expect(createMimoProvider(cfg).search({ query: "q", count: 8 }, ctx(fetchImpl))).rejects.toMatchObject({
      name: "ParseError",
    });
  });

  it("caps the citation list at the requested count", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        choices: [{ message: { content: "a", annotations: [
          { type: "url_citation", title: "1", url: "https://a.example/1" },
          { type: "url_citation", title: "2", url: "https://a.example/2" },
          { type: "url_citation", title: "3", url: "https://a.example/3" },
        ] } }],
      });
    const out = await createMimoProvider(cfg).search({ query: "q", count: 2 }, ctx(fetchImpl));
    expect(out.results).toHaveLength(2);
  });

  it("falls back to the default model when config has none", async () => {
    let seen: any;
    const fetchImpl: FetchLike = async (_url, init) => {
      seen = JSON.parse(init!.body as string);
      return jsonResponse({ choices: [{ message: { content: "", annotations: [] } }] });
    };
    await createMimoProvider({ apiKey: "k", baseUrl: "https://m.example/v1" }).search(
      { query: "q", count: 1 },
      ctx(fetchImpl),
    );
    expect(seen.model).toBe("mimo-v2.5");
  });

  it("propagates HTTP errors (classified by http layer)", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ error: "rate limited" }, 429);
    await expect(createMimoProvider(cfg).search({ query: "q", count: 8 }, ctx(fetchImpl))).rejects.toMatchObject({
      status: 429,
    });
  });

  it("throws ParseError on structurally broken payloads", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ choices: "not-an-array" });
    await expect(createMimoProvider(cfg).search({ query: "q", count: 8 }, ctx(fetchImpl))).rejects.toMatchObject({
      name: "ParseError",
    });
  });

  it("sends only the country by default and never a hardcoded city", async () => {
    let seen: any;
    const fetchImpl: FetchLike = async (_url, init) => {
      seen = JSON.parse(init!.body as string);
      return jsonResponse({ choices: [{ message: { content: "", annotations: [] } }] });
    };
    await createMimoProvider(cfg).search({ query: "q", count: 1 }, ctx(fetchImpl));
    expect(seen.tools[0].user_location).toEqual({ type: "approximate", country: "China" });
  });

  it("honours configurable location, maxKeyword and forceSearch", async () => {
    let seen: any;
    const fetchImpl: FetchLike = async (_url, init) => {
      seen = JSON.parse(init!.body as string);
      return jsonResponse({ choices: [{ message: { content: "", annotations: [] } }] });
    };
    await createMimoProvider({
      ...cfg,
      options: { location: { country: "US", region: "CA", city: "SF" }, maxKeyword: 5, forceSearch: false },
    }).search({ query: "q", count: 1 }, ctx(fetchImpl));
    expect(seen.tools[0].user_location).toEqual({ type: "approximate", country: "US", region: "CA", city: "SF" });
    expect(seen.tools[0].max_keyword).toBe(5);
    expect(seen.tools[0].force_search).toBe(false);
  });

  it("falls back to neutral defaults when location options are malformed", async () => {
    let seen: any;
    const fetchImpl: FetchLike = async (_url, init) => {
      seen = JSON.parse(init!.body as string);
      return jsonResponse({ choices: [{ message: { content: "", annotations: [] } }] });
    };
    await createMimoProvider({ ...cfg, options: { location: "not-an-object" } }).search(
      { query: "q", count: 1 },
      ctx(fetchImpl),
    );
    expect(seen.tools[0].user_location).toEqual({ type: "approximate", country: "China" });
  });

  it("exposes the configured per-provider timeout budget", () => {
    expect(createMimoProvider({ ...cfg, timeoutMs: 1234 }).timeoutMs).toBe(1234);
  });
});
