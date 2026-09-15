/**
 * @file test/kimi
 * @description Kimi adapter unit tests: 4-step loop, reasoning_content passthrough,
 * reference dedupe, multi-round convergence and abort/parse error paths.
 */

import { describe, expect, it } from "vitest";
import { createKimiProvider } from "../src/providers/kimi.js";
import { TimeoutError } from "../src/errors.js";
import type { FetchLike, SearchContext } from "../src/types.js";

const okFetchNever: FetchLike = () => new Promise(() => {}); // never resolves

const ctx = (fetchImpl: FetchLike): SearchContext => ({
  timeoutMs: 5_000,
  signal: new AbortController().signal,
  fetchImpl,
});

const cfg = { apiKey: "test-key", baseUrl: "https://kimi.example/v1", model: "kimi-test" };

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** Routes mock calls in order: first /chat/completions, then /formulas/.../fibers, finally the closing chat. */
function sequentialFetch(responses: Array<() => Response>): { fetchImpl: FetchLike; calls: Array<{ url: string; body: any }> } {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = JSON.parse(init!.body as string);
    calls.push({ url, body });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    return next();
  };
  return { fetchImpl, calls };
}

describe("kimi provider", () => {
  it("isConfigured reflects key presence", () => {
    expect(createKimiProvider(cfg).isConfigured()).toBe(true);
    expect(createKimiProvider({ ...cfg, apiKey: "" }).isConfigured()).toBe(false);
  });

  it("runs the 4-step loop and collects fiber references + final answer", async () => {
    const { fetchImpl, calls } = sequentialFetch([
      () =>
        jsonResponse({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              reasoning_content: "thinking...",
              tool_calls: [{ id: "tc1", type: "function", function: { name: "web_search", arguments: '{"query":"q"}' } }],
            },
          }],
        }),
      () =>
        jsonResponse({
          context: {
            encrypted_output: "ENCRYPTED",
            references: ["https://r.example/1", { url: "https://r.example/2" }, "https://r.example/1"],
          },
        }),
      () => jsonResponse({ choices: [{ message: { role: "assistant", content: "最终答案" } }] }),
    ]);
    const out = await createKimiProvider(cfg).search({ query: "q", count: 8 }, ctx(fetchImpl));

    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe("https://kimi.example/v1/chat/completions");
    expect(calls[0]!.body.tools[0].function.name).toBe("web_search");
    expect(calls[1]!.url).toBe("https://kimi.example/v1/formulas/moonshot/web-search:latest/fibers");
    expect(calls[1]!.body.name).toBe("web_search");
    // The second step (follow-up chat) must pass reasoning_content through verbatim.
    expect(calls[2]!.body.messages.some((m: any) => m.reasoning_content === "thinking...")).toBe(true);
    expect(out._meta.answer).toBe("最终答案");
    // References are deduped; missing titles fall back to the hostname.
    expect(out.results).toEqual([
      { title: "r.example", url: "https://r.example/1", snippet: "" },
      { title: "r.example", url: "https://r.example/2", snippet: "" },
    ]);
  });

  it("returns the direct content when the model skips tool calls", async () => {
    const { fetchImpl, calls } = sequentialFetch([
      () => jsonResponse({ choices: [{ message: { role: "assistant", content: "不用搜索我知道" } }] }),
    ]);
    const out = await createKimiProvider(cfg).search({ query: "q", count: 8 }, ctx(fetchImpl));
    expect(calls).toHaveLength(1);
    expect(out._meta.answer).toBe("不用搜索我知道");
    expect(out.results).toEqual([]);
  });

  it("stops early when count is reached", async () => {
    const { fetchImpl } = sequentialFetch([
      () =>
        jsonResponse({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "tc1", type: "function", function: { name: "web_search", arguments: "{}" } }],
            },
          }],
        }),
      () => jsonResponse({ context: { encrypted_output: "E", references: ["https://a.example/1", "https://b.example/2", "https://c.example/3"] } }),
      () => jsonResponse({ choices: [{ message: { content: "done" } }] }),
    ]);
    const out = await createKimiProvider(cfg).search({ query: "q", count: 2 }, ctx(fetchImpl));
    expect(out.results).toHaveLength(2);
  });

  it("falls back to the default model and to context.output when encrypted_output is absent", async () => {
    const { fetchImpl, calls } = sequentialFetch([
      () =>
        jsonResponse({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "tc1", type: "function", function: { name: "web_search", arguments: "{}" } }],
            },
          }],
        }),
      () => jsonResponse({ context: { output: "PLAIN OUTPUT", references: [{ nope: true }, null, "https://ok.example/1"] } }),
      () => jsonResponse({ choices: [{ message: { content: "done" } }] }),
    ]);
    const out = await createKimiProvider({ apiKey: "k", baseUrl: "https://kimi.example/v1" }).search(
      { query: "q", count: 8 },
      ctx(fetchImpl),
    );
    expect(calls[0]!.body.model).toBe("kimi-k3");
    expect(out._meta.answer).toBe("done");
    // Entries without a usable url are silently skipped
    expect(out.results).toEqual([{ title: "ok.example", url: "https://ok.example/1", snippet: "" }]);
  });

  it("runs a final tool-less chat when the last round still demands tools", async () => {
    // Rounds 0 and 1 both return tool_calls; after the last fiber,
    // the loop must run one more tool-less closing chat to produce the final answer.
    const { fetchImpl, calls } = sequentialFetch([
      () =>
        jsonResponse({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "tc1", type: "function", function: { name: "web_search", arguments: "{}" } }],
            },
          }],
        }),
      () => jsonResponse({ context: { encrypted_output: "E1", references: ["https://r1.example/1"] } }),
      () =>
        jsonResponse({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "tc2", type: "function", function: { name: "web_search", arguments: "{}" } }],
            },
          }],
        }),
      () => jsonResponse({ context: { encrypted_output: "E2" } }), // no references at all
      () => jsonResponse({ choices: [{ message: { content: "" } }] }), // final answer is empty
    ]);
    const out = await createKimiProvider(cfg).search({ query: "q", count: 8 }, ctx(fetchImpl));
    // The last chat is the tool-less one (the final request has no tools field).
    expect(calls).toHaveLength(5);
    expect(calls[4]!.body.tools).toBeUndefined();
    expect(out._meta.answer).toBeUndefined(); // an empty answer is never fabricated
    expect(out.results).toEqual([{ title: "r1.example", url: "https://r1.example/1", snippet: "" }]);
  });

  it("throws ParseError on empty choices, missing message, and context-less fibers", async () => {
    for (const payload of [
      { choices: [] },
      { choices: [{ id: "c1" }] },
    ]) {
      const { fetchImpl } = sequentialFetch([() => jsonResponse(payload)]);
      await expect(createKimiProvider(cfg).search({ query: "q", count: 8 }, ctx(fetchImpl))).rejects.toMatchObject({
        name: "ParseError",
      });
    }
    // Fiber response without a context object: yields an empty result, but the closing chat still runs.
    const { fetchImpl } = sequentialFetch([
      () =>
        jsonResponse({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "tc1", type: "function", function: { name: "web_search", arguments: "{}" } }],
            },
          }],
        }),
      () => jsonResponse({ unexpected: true }),
      () => jsonResponse({ choices: [{ message: { content: "done" } }] }),
    ]);
    const out = await createKimiProvider(cfg).search({ query: "q", count: 8 }, ctx(fetchImpl));
    expect(out.results).toEqual([]);
    expect(out._meta.answer).toBe("done");
  });

  it("throws ParseError when a tool_call lacks its function descriptor", async () => {
    const { fetchImpl } = sequentialFetch([
      () =>
        jsonResponse({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "tc1", type: "function" }],
            },
          }],
        }),
    ]);
    await expect(createKimiProvider(cfg).search({ query: "q", count: 8 }, ctx(fetchImpl))).rejects.toMatchObject({
      name: "ParseError",
    });
  });

  it("aborts between steps when the signal fires with a non-Error reason", async () => {
    const ac = new AbortController();
    ac.abort("caller-string"); // abort reason is not an Error
    const abortedCtx: SearchContext = { timeoutMs: 1_000, signal: ac.signal, fetchImpl: okFetchNever };
    await expect(createKimiProvider(cfg).search({ query: "q", count: 8 }, abortedCtx)).rejects.toMatchObject({
      name: "ParseError",
    });
  });

  it("aborts between steps when the signal fires with a TimeoutError reason", async () => {
    const ac = new AbortController();
    ac.abort(new TimeoutError("deadline"));
    const abortedCtx: SearchContext = { timeoutMs: 1_000, signal: ac.signal, fetchImpl: okFetchNever };
    await expect(createKimiProvider(cfg).search({ query: "q", count: 8 }, abortedCtx)).rejects.toBeInstanceOf(
      TimeoutError,
    );
  });

  it("propagates HTTP errors from the chat endpoint", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response('{"error":{"message":"bad key"}}', { status: 401 });
    await expect(createKimiProvider(cfg).search({ query: "q", count: 8 }, ctx(fetchImpl))).rejects.toMatchObject({
      status: 401,
    });
  });

  it("honours configurable maxRounds and maxTokens", async () => {
    const { fetchImpl, calls } = sequentialFetch([
      () =>
        jsonResponse({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "tc1", type: "function", function: { name: "web_search", arguments: "{}" } }],
            },
          }],
        }),
      () => jsonResponse({ context: { encrypted_output: "E", references: ["https://a.example/1"] } }),
      () => jsonResponse({ choices: [{ message: { content: "done" } }] }),
    ]);
    await createKimiProvider({ ...cfg, options: { maxRounds: 1, maxTokens: 512 } }).search(
      { query: "q", count: 8 },
      ctx(fetchImpl),
    );
    // maxRounds=1: converge via the closing chat right after one round of tool calls (3 requests total).
    expect(calls).toHaveLength(3);
    expect(calls[2]!.body.tools).toBeUndefined();
    expect(calls[0]!.body.max_tokens).toBe(512);
  });

  it("clamps out-of-range options back to sane defaults", async () => {
    const { fetchImpl, calls } = sequentialFetch([
      () => jsonResponse({ choices: [{ message: { content: "no tools" } }] }),
    ]);
    await createKimiProvider({ ...cfg, options: { maxRounds: 99, maxTokens: 1 } }).search(
      { query: "q", count: 8 },
      ctx(fetchImpl),
    );
    expect(calls[0]!.body.max_tokens).toBe(256);
  });

  it("exposes the configured per-provider timeout budget", () => {
    expect(createKimiProvider({ ...cfg, timeoutMs: 55 }).timeoutMs).toBe(55);
  });
});
