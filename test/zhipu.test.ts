/**
 * @file test/zhipu
 * @description Zhipu adapter unit tests: web_search API request construction, field mapping and clamping.
 */

import { describe, expect, it } from "vitest";
import { createZhipuProvider } from "../src/providers/zhipu.js";
import type { FetchLike, SearchContext } from "../src/types.js";

const ctx = (fetchImpl: FetchLike): SearchContext => ({
  timeoutMs: 5_000,
  signal: new AbortController().signal,
  fetchImpl,
});

const cfg = { apiKey: "test-key", baseUrl: "https://zhipu.example" };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

describe("zhipu provider", () => {
  it("isConfigured reflects key presence", () => {
    expect(createZhipuProvider(cfg).isConfigured()).toBe(true);
    expect(createZhipuProvider({ ...cfg, apiKey: "" }).isConfigured()).toBe(false);
  });

  it("calls the standalone web_search API and maps search_result fields", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init: init! });
      return jsonResponse({
        id: "t1",
        search_result: [
          { title: "北京天气", link: "https://weather.example/bj", content: "北京今天晴。", media: "示例网", publish_date: "2026-09-15", refer: "ref_1" },
          { title: "no-link entry", content: "should be dropped" },
        ],
      });
    };
    const out = await createZhipuProvider(cfg).search({ query: "北京天气", count: 8 }, ctx(fetchImpl));
    expect(calls[0]!.url).toBe("https://zhipu.example/api/paas/v4/web_search");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.search_query).toBe("北京天气");
    expect(body.search_engine).toBe("search_std");
    expect(body.count).toBe(8);
    expect(body.content_size).toBe("high");
    expect(out._meta.provider).toBe("zhipu");
    expect(out.results).toEqual([
      {
        title: "北京天气",
        url: "https://weather.example/bj",
        snippet: "北京今天晴。",
        content: "北京今天晴。",
        published_date: "2026-09-15",
      },
    ]);
  });

  it("truncates search_query to 70 chars and clamps count", async () => {
    let seen: any;
    const fetchImpl: FetchLike = async (_url, init) => {
      seen = JSON.parse(init!.body as string);
      return jsonResponse({ search_result: [] });
    };
    await createZhipuProvider(cfg).search({ query: "x".repeat(120), count: 999 }, ctx(fetchImpl));
    expect(seen.search_query).toHaveLength(70);
    expect(seen.count).toBe(50);
  });

  it("honors a custom search engine from extra config", async () => {
    let seen: any;
    const fetchImpl: FetchLike = async (_url, init) => {
      seen = JSON.parse(init!.body as string);
      return jsonResponse({ search_result: [] });
    };
    await createZhipuProvider({ ...cfg, options: { searchEngine: "search_pro_quark" } }).search(
      { query: "q", count: 5 },
      ctx(fetchImpl),
    );
    expect(seen.search_engine).toBe("search_pro_quark");
  });

  it("honours a configurable content_size and defaults it to high", async () => {
    const bodies: any[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string));
      return jsonResponse({ search_result: [] });
    };
    await createZhipuProvider({ ...cfg, options: { contentSize: "medium" } }).search(
      { query: "q", count: 1 },
      ctx(fetchImpl),
    );
    await createZhipuProvider(cfg).search({ query: "q", count: 1 }, ctx(fetchImpl));
    expect(bodies[0].content_size).toBe("medium");
    expect(bodies[1].content_size).toBe("high");
  });

  it("exposes the configured per-provider timeout budget", () => {
    expect(createZhipuProvider({ ...cfg, timeoutMs: 777 }).timeoutMs).toBe(777);
  });

  it("drops malformed hits and truncates snippet to 300 chars", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        search_result: [
          null,
          42,
          { title: "Long", link: "https://long.example/1", content: "z".repeat(500), publish_date: "" },
        ],
      });
    const out = await createZhipuProvider(cfg).search({ query: "q", count: 8 }, ctx(fetchImpl));
    expect(out.results).toEqual([
      { title: "Long", url: "https://long.example/1", snippet: "z".repeat(300), content: "z".repeat(500) },
    ]);
  });

  it("propagates HTTP errors", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ error: { code: "1702" } }, 400);
    await expect(createZhipuProvider(cfg).search({ query: "q", count: 8 }, ctx(fetchImpl))).rejects.toMatchObject({
      status: 400,
    });
  });
});
