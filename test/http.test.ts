/**
 * @file test/http
 * @description HTTP helper layer unit tests: timeout merging, external aborts, error classification, response body size limits and message truncation.
 */

import { describe, expect, it } from "vitest";
import { postJson } from "../src/http.js";
import { HttpError, NetworkError, ParseError, TimeoutError } from "../src/errors.js";
import type { FetchLike } from "../src/types.js";

const okFetch: FetchLike = async () =>
  new Response(JSON.stringify({ hello: "world" }), { status: 200, headers: { "Content-Type": "application/json" } });

const base = { timeoutMs: 5_000, fetchImpl: okFetch };

describe("postJson", () => {
  it("posts JSON and parses the response", async () => {
    let seen: RequestInit | undefined;
    const spy: FetchLike = async (url, init) => {
      seen = init;
      return okFetch(url, init);
    };
    const res = await postJson("https://x.example/v1", { a: 1 }, { Authorization: "Bearer secret" }, {
      ...base,
      fetchImpl: spy,
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ hello: "world" });
    expect(seen?.method).toBe("POST");
    expect(JSON.parse(seen?.body as string)).toEqual({ a: 1 });
  });

  it("throws HttpError with status for >= 400", async () => {
    const f: FetchLike = async () => new Response('{"error":"nope"}', { status: 401 });
    await expect(postJson("https://x.example", {}, {}, { ...base, fetchImpl: f })).rejects.toBeInstanceOf(HttpError);
  });

  it("wraps fetch failures as NetworkError (transient)", async () => {
    const f: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(postJson("https://x.example", {}, {}, { ...base, fetchImpl: f })).rejects.toBeInstanceOf(NetworkError);
  });

  it("throws TimeoutError when the per-request timeout fires", async () => {
    const f: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await expect(
      postJson("https://x.example", {}, {}, { timeoutMs: 30, fetchImpl: f }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it("propagates an external abort", async () => {
    const ac = new AbortController();
    const f: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const p = postJson("https://x.example", {}, {}, { timeoutMs: 5_000, signal: ac.signal, fetchImpl: f });
    setTimeout(() => ac.abort(new TimeoutError("caller deadline")), 10);
    await expect(p).rejects.toBeInstanceOf(TimeoutError);
  });

  it("short-circuits when the external signal is already aborted on entry", async () => {
    const ac = new AbortController();
    ac.abort(); // abort without any reason
    // Real fetch rejects immediately when the signal is already aborted.
    const f: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) reject(new Error("aborted"));
        else init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const err = await postJson("https://x.example", {}, {}, {
      timeoutMs: 5_000,
      signal: ac.signal,
      fetchImpl: f,
    }).catch((e) => e);
    // A reason-less abort() surfaces Node's default AbortError DOMException.
    expect((err as Error).name).toBe("AbortError");
  });

  it("wraps non-Error fetch rejections as NetworkError via String()", async () => {
    const f: FetchLike = () => Promise.reject("plain string rejection");
    const err = await postJson("https://x.example", {}, {}, { ...base, fetchImpl: f }).catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).message).toBe("plain string rejection");
  });

  it("uses the default TimeoutError when an abort carries a non-Error reason", async () => {
    const ac = new AbortController();
    const f: FetchLike = async () => {
      ac.abort("string reason");
      throw new TypeError("fetch failed");
    };
    const err = await postJson("https://x.example", {}, {}, {
      timeoutMs: 5_000,
      signal: ac.signal,
      fetchImpl: f,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).message).toBe("request timed out");
  });

  it("wraps a broken response body as NetworkError when not aborted", async () => {
    const broken = { status: 200, text: () => Promise.reject(new Error("stream broken")) } as unknown as Response;
    const f: FetchLike = async () => broken;
    await expect(postJson("https://x.example", {}, {}, { ...base, fetchImpl: f })).rejects.toBeInstanceOf(
      NetworkError,
    );
  });

  it("throws TimeoutError when the body read fails after an abort with a non-Error reason", async () => {
    const ac = new AbortController();
    const broken = { status: 200, text: () => Promise.reject(new Error("stream broken")) } as unknown as Response;
    const f: FetchLike = async () => {
      ac.abort("string reason");
      return broken;
    };
    await expect(
      postJson("https://x.example", {}, {}, { timeoutMs: 5_000, signal: ac.signal, fetchImpl: f }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it("truncates very long HTTP error bodies in the message", async () => {
    const f: FetchLike = async () => new Response("y".repeat(1000), { status: 500 });
    const err = await postJson("https://x.example", {}, {}, { ...base, fetchImpl: f }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message).toContain("HTTP 500:");
    expect((err as HttpError).message.length).toBeLessThan(330);
  });

  it("redacts credential-looking text from upstream error bodies", async () => {
    const f: FetchLike = async () =>
      new Response('{"message":"account org-0123456789abcdef <ak-EXAMPLEKEY01234567890> suspended"}', { status: 429 });
    const err = (await postJson("https://x.example", {}, {}, { ...base, fetchImpl: f }).catch((e) => e)) as HttpError;
    expect(err.message).not.toContain("0123456789abcdef");
    expect(err.message).not.toContain("EXAMPLEKEY01234567890");
    expect(err.message).toContain("ak-***");
  });

  it("redacts a secret that straddles the truncation boundary", async () => {
    // Truncating first and redacting after leaves the head of a secret that
    // crosses the cut in the message: the 300-char slice ends mid-credential,
    // and the short remainder no longer matches any pattern.
    const pad = "y".repeat(290);
    const secret = "sk-0123456789abcdef";
    const f: FetchLike = async () => new Response(`${pad} ${secret} denied`, { status: 500 });
    const err = (await postJson("https://x.example", {}, {}, { ...base, fetchImpl: f }).catch((e) => e)) as HttpError;
    expect(err.message).not.toContain("0123456");
    expect(err.message).toContain("sk-***");
  });

  it("reports the status, not a redaction failure, for a huge error body of one long word run", async () => {
    // A proxy or WAF error page is HTML carrying a multi-megabyte unbroken run
    // of word characters. The dot-form redaction pattern's greedy run used to
    // overflow V8's regex backtrack stack on input like this, and the RangeError
    // it threw escaped from the throw expression below: the call reported
    // "RangeError: Maximum call stack size exceeded" instead of the 400 that
    // actually explains the failure. 7 MB is under the 8 MB body cap, so this
    // is a body the layer accepts and must describe.
    const f: FetchLike = async () => new Response("<html>" + "a".repeat(7 * 1024 * 1024) + "</html>", { status: 400 });
    const err = (await postJson("https://x.example", {}, {}, { ...base, fetchImpl: f }).catch((e) => e)) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(400);
    expect(err.message).toContain("HTTP 400:");
    expect(err.message).not.toContain("RangeError");
    expect(err.message).not.toContain("Maximum call stack");
  });

  it("still redacts credentials in a huge error body", async () => {
    // The bound must not become a shortcut around redaction: same body shape as
    // above, with the real-world Kimi 429 payload at its head.
    const body = '{"message":"Your account org-0123456789abcdef <ak-EXAMPLEKEY01234567890> is suspended"}' +
      "a".repeat(7 * 1024 * 1024);
    const f: FetchLike = async () => new Response(body, { status: 429 });
    const err = (await postJson("https://x.example", {}, {}, { ...base, fetchImpl: f }).catch((e) => e)) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.message).not.toContain("0123456789abcdef");
    expect(err.message).not.toContain("EXAMPLEKEY01234567890");
    expect(err.message).toContain("ak-***");
  });

  it("propagates an Error abort reason from the body read unchanged", async () => {
    // The orchestrator's own TimeoutError must survive the body read; wrapping
    // it again would lose the identity the audit trail classifies on.
    const ac = new AbortController();
    const reason = new TimeoutError("budget spent");
    const broken = { status: 200, text: () => Promise.reject(new Error("stream broken")) } as unknown as Response;
    const f: FetchLike = async () => {
      ac.abort(reason);
      return broken;
    };
    const err = await postJson("https://x.example", {}, {}, { timeoutMs: 5_000, signal: ac.signal, fetchImpl: f }).catch(
      (e) => e,
    );
    expect(err).toBe(reason);
  });

  it("parses a body that starts with a UTF-8 BOM", async () => {
    const f: FetchLike = async () =>
      new Response("\uFEFF" + JSON.stringify({ choices: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    const res = await postJson("https://x.example", {}, {}, { ...base, fetchImpl: f });
    expect(res.json).toEqual({ choices: [] });
  });

  it("returns json null for non-JSON success bodies", async () => {
    const f: FetchLike = async () => new Response("<html>ok</html>", { status: 200 });
    const res = await postJson("https://x.example", {}, {}, { ...base, fetchImpl: f });
    expect(res.status).toBe(200);
    expect(res.json).toBeNull();
  });

  it("refuses a body whose Content-Length exceeds the cap", async () => {
    const huge = new Response("{}", { status: 200, headers: { "Content-Length": String(64 * 1024 * 1024) } });
    const f: FetchLike = async () => huge;
    const err = await postJson("https://x.example", {}, {}, { ...base, fetchImpl: f }).catch((e) => e);
    // A permanent failure: retrying an oversized body would just re-download it.
    expect(err).toBeInstanceOf(ParseError);
    expect((err as ParseError).message).toContain("too large");
  });

  it("refuses a body that understates its size and offers no stream to count", async () => {
    // A Response-shaped object without a readable body falls back to text(),
    // which the Content-Length pre-check cannot bound: an upstream that
    // declares a small length and then sends an oversized payload would
    // otherwise be buffered whole and reported as a normal success.
    const oversized = "y".repeat(9 * 1024 * 1024);
    const lying = {
      status: 200,
      headers: new Headers({ "Content-Length": "12" }),
      text: async () => oversized,
    } as unknown as Response;
    const f: FetchLike = async () => lying;
    const err = await postJson("https://x.example", {}, {}, { ...base, fetchImpl: f }).catch((e) => e);
    expect(err).toBeInstanceOf(ParseError);
    // The message must name the limit, so an operator can tell what was
    // exceeded rather than only that something was.
    expect((err as ParseError).message).toContain("8388608");
  });

  it("accepts a legal body from a response with no stream to count", async () => {
    // The counterpart of the check above: the non-streaming fallback measures
    // the text it already buffered, so a body *inside* the cap must still come
    // back as a normal success. Without this the fallback could refuse every
    // response-shaped object that lacks a reader and the test above would
    // still pass.
    const noStream = {
      status: 200,
      headers: new Headers({ "Content-Length": "7" }),
      text: async () => '{"a":1}',
    } as unknown as Response;
    const f: FetchLike = async () => noStream;
    const res = await postJson("https://x.example", {}, {}, { ...base, fetchImpl: f });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ a: 1 });
  });

  it("wraps a body read that fails with a non-Error throwable", async () => {
    // The body read is a second failure site with its own classification; a
    // rejection that is not an Error must still become a NetworkError rather
    // than escaping postJson as a bare string.
    const broken = { status: 200, text: () => Promise.reject("string body failure") } as unknown as Response;
    const f: FetchLike = async () => broken;
    const err = await postJson("https://x.example", {}, {}, { ...base, fetchImpl: f }).catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).message).toBe("string body failure");
  });

  it("skips a nullish chunk instead of failing the read", async () => {
    // A reader is allowed to hand back a chunk-less tick; counting it as zero
    // bytes keeps the body intact instead of throwing on `value.byteLength`.
    const stream = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue(undefined);
        controller.enqueue(new TextEncoder().encode('{"a":1}'));
        controller.close();
      },
    });
    const f: FetchLike = async () => new Response(stream as never, { status: 200 });
    const res = await postJson("https://x.example", {}, {}, { ...base, fetchImpl: f });
    expect(res.json).toEqual({ a: 1 });
  });

  it("uses the default TimeoutError when a body lands after a non-Error abort", async () => {
    // The post-read abort check is a third site with the same shape as the
    // fetch-level one: a reason supplied by the caller is never echoed back,
    // because it is data the peer chose.
    const ac = new AbortController();
    const f: FetchLike = async () => {
      ac.abort("string reason");
      return new Response('{"a":1}', { status: 200 });
    };
    const err = await postJson("https://x.example", {}, {}, {
      timeoutMs: 5_000,
      signal: ac.signal,
      fetchImpl: f,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).message).toBe("request timed out");
  });

  it("refuses a streamed body that grows past the cap", async () => {
    const chunk = new TextEncoder().encode("y".repeat(1024));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 9000; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const f: FetchLike = async () => new Response(stream, { status: 200 });
    const err = await postJson("https://x.example", {}, {}, { ...base, fetchImpl: f }).catch((e) => e);
    expect(err).toBeInstanceOf(ParseError);
    expect((err as ParseError).message).toContain("too large");
  });

  it("still reads a large-but-legal body through the streaming path", async () => {
    const pad = "z".repeat(300_000);
    const f: FetchLike = async () => new Response(JSON.stringify({ choices: [], pad }), { status: 200 });
    const res = await postJson("https://x.example", {}, {}, { ...base, fetchImpl: f });
    // Asserted on the parsed body: a body past the initial buffer has to survive
    // the growth of the accumulating buffer whole, not truncated at a capacity.
    expect(res.json).toEqual({ choices: [], pad });
  });

  it("assembles a body delivered in many small chunks", async () => {
    // The streaming reader accumulates into one growing buffer, so the chunk
    // size an upstream picks cannot change the bytes that come out the other
    // end, nor how much memory the read costs. 16-byte chunks are a realistic
    // trickle, and 5000 of them carry the body past the initial buffer, so this
    // covers the growth as well as the assembly.
    const text = JSON.stringify({ choices: [], pad: "abcdefghij".repeat(8_000) });
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 16) controller.enqueue(bytes.subarray(i, i + 16));
        controller.close();
      },
    });
    const f: FetchLike = async () => new Response(stream, { status: 200 });
    const res = await postJson("https://x.example", {}, {}, { ...base, fetchImpl: f });
    expect(res.json).toEqual(JSON.parse(text));
  });

  it("refuses a body that lands after the caller cancelled", async () => {
    // A fetch that resolves anyway despite the abort used to be reported as a
    // normal success, handing a result to a peer that had already gone away.
    const controller = new AbortController();
    const f: FetchLike = async () => {
      controller.abort(new Error("caller left"));
      return new Response(JSON.stringify({ hello: "world" }), { status: 200 });
    };
    const err = await postJson("https://x.example", {}, {}, {
      ...base,
      signal: controller.signal,
      fetchImpl: f,
    }).catch((e) => e);
    expect((err as Error).message).toBe("caller left");
  });

  it("refuses a body that lands after the per-request timeout", async () => {
    const f: FetchLike = async () => {
      await new Promise((r) => setTimeout(r, 40));
      return new Response("{}", { status: 200 });
    };
    const err = await postJson("https://x.example", {}, {}, { ...base, timeoutMs: 10, fetchImpl: f }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
  });
});
