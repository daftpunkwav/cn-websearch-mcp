/**
 * @file test/stepfun
 * @description StepFun adapter unit tests: REST request construction, field mapping and n clamping.
 */

import { describe, expect, it } from "vitest";
import { createStepfunProvider } from "../src/providers/stepfun.js";
import type { FetchLike, SearchContext } from "../src/types.js";

const ctx = (fetchImpl: FetchLike): SearchContext => ({
  timeoutMs: 5_000,
  signal: new AbortController().signal,
  fetchImpl,
});

const cfg = { apiKey: "test-key", baseUrl: "https://stepfun.example" };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

describe("stepfun provider", () => {
  it("isConfigured reflects key presence", () => {
    expect(createStepfunProvider(cfg).isConfigured()).toBe(true);
    expect(createStepfunProvider({ ...cfg, apiKey: "" }).isConfigured()).toBe(false);
  });

  it("calls /v1/search with n and maps result fields incl. full text", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init: init! });
      return jsonResponse({
        query: "q",
        results: [
          {
            url: "https://docs.example/1",
            position: 1,
            title: "Doc One",
            time: "2026-03-20T00:00:00",
            snippet: "short summary",
            content: "full page text",
          },
          { position: 2, title: "no url" },
        ],
      });
    };
    const out = await createStepfunProvider(cfg).search({ query: "q", count: 8 }, ctx(fetchImpl));
    expect(calls[0]!.url).toBe("https://stepfun.example/v1/search");
    expect(calls[0]!.init.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json; charset=utf-8",
    });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ query: "q", n: 8 });
    expect(out._meta.provider).toBe("stepfun");
    expect(out.results).toEqual([
      {
        title: "Doc One",
        url: "https://docs.example/1",
        snippet: "short summary",
        content: "full page text",
        published_date: "2026-03-20T00:00:00",
      },
    ]);
  });

  it("clamps n into the documented 1..20 range", async () => {
    let seen: any;
    const fetchImpl: FetchLike = async (_url, init) => {
      seen = JSON.parse(init!.body as string);
      return jsonResponse({ results: [] });
    };
    await createStepfunProvider(cfg).search({ query: "q", count: 100 }, ctx(fetchImpl));
    expect(seen.n).toBe(20);
  });

  it("drops malformed hits and omits empty content", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        results: [
          null,
          "garbage",
          { url: "https://lean.example/1", title: "Lean", snippet: "just a snippet", content: "" },
        ],
      });
    const out = await createStepfunProvider(cfg).search({ query: "q", count: 8 }, ctx(fetchImpl));
    expect(out.results).toEqual([
      { title: "Lean", url: "https://lean.example/1", snippet: "just a snippet", published_date: undefined },
    ]);
  });

  it("propagates HTTP errors", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ message: "quota" }, 429);
    await expect(createStepfunProvider(cfg).search({ query: "q", count: 8 }, ctx(fetchImpl))).rejects.toMatchObject({
      status: 429,
    });
  });

  it("sends the configured category and omits it when unset", async () => {
    const bodies: any[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string));
      return jsonResponse({ results: [] });
    };
    await createStepfunProvider({ ...cfg, options: { category: "news" } }).search(
      { query: "q", count: 1 },
      ctx(fetchImpl),
    );
    await createStepfunProvider(cfg).search({ query: "q", count: 1 }, ctx(fetchImpl));
    expect(bodies[0]).toEqual({ query: "q", n: 1, category: "news" });
    expect(bodies[1].category).toBeUndefined();
  });

  it("exposes the configured per-provider timeout budget", () => {
    expect(createStepfunProvider({ ...cfg, timeoutMs: 999 }).timeoutMs).toBe(999);
  });
});
