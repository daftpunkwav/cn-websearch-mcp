/**
 * @file test/http
 * @description HTTP helper layer unit tests: timeout merging, external aborts, error classification and truncation.
 */

import { describe, expect, it } from "vitest";
import { postJson } from "../src/http.js";
import { HttpError, NetworkError, TimeoutError } from "../src/errors.js";
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

  it("returns json null for non-JSON success bodies", async () => {
    const f: FetchLike = async () => new Response("<html>ok</html>", { status: 200 });
    const res = await postJson("https://x.example", {}, {}, { ...base, fetchImpl: f });
    expect(res.status).toBe(200);
    expect(res.json).toBeNull();
  });
});
