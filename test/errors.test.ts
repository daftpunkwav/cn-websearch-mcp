/**
 * @file test/errors
 * @description Error taxonomy unit tests: error class naming, transient/permanent classification, summary generation and credential redaction.
 */

import { describe, expect, it } from "vitest";
import {
  HttpError,
  NetworkError,
  ParseError,
  redactSecrets,
  TimeoutError,
  isTransient,
  summarizeError,
} from "../src/errors.js";

describe("error classes", () => {
  it("carry their names", () => {
    expect(new TimeoutError().name).toBe("TimeoutError");
    expect(new NetworkError("x").name).toBe("NetworkError");
    expect(new HttpError(500, "x").name).toBe("HttpError");
    expect(new ParseError("x").name).toBe("ParseError");
    expect(new HttpError(503, "x").status).toBe(503);
  });

  it("TimeoutError has a default message", () => {
    expect(new TimeoutError().message).toBe("request timed out");
  });
});

describe("isTransient", () => {
  it("treats network errors as retryable", () => {
    expect(isTransient(new NetworkError("fetch failed"))).toBe(true);
  });

  it("does not treat a timeout as retryable, whoever raised it", () => {
    // A timeout means the wall-clock budget is gone. Retrying it would hand the
    // same spent budget to the same channel, so the documented worst case stays
    // 2 x timeoutMs + backoff per channel instead of 3 x.
    expect(isTransient(new TimeoutError())).toBe(false);
    expect(isTransient(new TimeoutError("caller deadline"))).toBe(false);
  });

  it("treats 5xx and 429 as retryable, other 4xx as permanent", () => {
    expect(isTransient(new HttpError(500, "boom"))).toBe(true);
    expect(isTransient(new HttpError(503, "boom"))).toBe(true);
    expect(isTransient(new HttpError(429, "slow down"))).toBe(true);
    expect(isTransient(new HttpError(401, "bad key"))).toBe(false);
    expect(isTransient(new HttpError(400, "bad request"))).toBe(false);
  });

  it("treats everything else as permanent", () => {
    expect(isTransient(new ParseError("shape"))).toBe(false);
    expect(isTransient(new Error("whatever"))).toBe(false);
    expect(isTransient("a string")).toBe(false);
    expect(isTransient(undefined)).toBe(false);
  });
});

describe("summarizeError", () => {
  it("formats Error instances with name and message", () => {
    expect(summarizeError(new HttpError(401, "HTTP 401: bad key"))).toBe("HttpError: HTTP 401: bad key");
  });

  it("truncates very long messages to 300 chars", () => {
    const long = "x".repeat(500);
    const summary = summarizeError(new Error(long));
    expect(summary).toHaveLength("Error: ".length + 300 + "...".length);
    expect(summary.endsWith("...")).toBe(true);
  });

  it("stringifies non-Error throwables", () => {
    expect(summarizeError("plain string")).toBe("plain string");
    expect(summarizeError(42)).toBe("42");
  });

  it("collapses whitespace so the audit trail stays on one line", () => {
    expect(summarizeError(new Error("line one\n  line two"))).toBe("Error: line one line two");
  });

  it("redacts credential-looking text before it can reach the audit trail", () => {
    const summary = summarizeError(new Error("key sk-EXAMPLEKEY0123456789 rejected for org-0123456789abcdef"));
    expect(summary).not.toContain("sk-EXAMPLEKEY0123456789");
    expect(summary).not.toContain("0123456789abcdef");
    expect(summary).toContain("sk-***");
  });

  it("strips terminal escape sequences from upstream text", () => {
    // The audit trail is printed straight to the terminal by the CLI and sent to
    // MCP clients, so an upstream error body carrying ESC could repaint or forge
    // output lines. Newlines must survive as spaces, not vanish.
    const summary = summarizeError(new Error("failed\u001b[31mRED\u001b[0m\nnext line\u0007"));
    expect(summary).not.toContain("\u001b");
    expect(summary).not.toContain("\u0007");
    expect(summary).toBe("Error: failed[31mRED[0m next line");
  });

  it("strips escape sequences before matching, so a split secret is still redacted", () => {
    const summary = summarizeError(new Error("key sk-EXAMPLE\u0007KEY0123456789 rejected"));
    expect(summary).not.toContain("EXAMPLEKEY0123456789");
    expect(summary).toContain("sk-***");
  });
});

describe("redactSecrets", () => {
  it("redacts the real-world Kimi 429 payload shape (account id + ak- key)", () => {
    // Synthetic value: matches the shape of the real upstream error body (prefix + long random body), but contains no real identifiers.
    const body = '{"message":"Your account org-0123456789abcdef <ak-EXAMPLEKEY01234567890> is suspended"}';
    const out = redactSecrets(body);
    expect(out).not.toContain("0123456789abcdef");
    expect(out).not.toContain("EXAMPLEKEY01234567890");
    expect(out).toContain("org***");
    expect(out).toContain("ak-***");
  });

  it("redacts bearer tokens and assignment-style secrets", () => {
    expect(redactSecrets("Authorization: Bearer sk-abcdefghijklmnop123")).toBe("Authorization: Bearer sk-***");
    expect(redactSecrets("api_key=abcdef123456")).toBe("api***");
    expect(redactSecrets("token: abcdefghijkl")).toBe("tok***");
  });

  it("leaves ordinary prose and URLs alone", () => {
    expect(redactSecrets("the peak-performance run finished")).toBe("the peak-performance run finished");
    expect(redactSecrets("GET https://api.example.com/v1/chat failed")).toBe(
      "GET https://api.example.com/v1/chat failed",
    );
  });
});
