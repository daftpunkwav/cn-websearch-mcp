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

/**
 * Frozen redaction fixtures.
 *
 * Every sample is synthetic: it reproduces the *shape* an upstream error body
 * carries (a key prefix, a dot-form id.secret pair, an Authorization header)
 * using invented values. No real key, account id or org id appears here or in
 * any fixture in this suite — these files live in git.
 *
 * The list is the contract for SECRET_PATTERNS itself. Upstreams decide what
 * an error body looks like without asking us, so the coverage this locks in is
 * "every shape we have actually seen, plus every documented key format of the
 * four channels we integrate", not "every shape that could exist". A pattern
 * deleted or narrowed fails here rather than in a user's audit trail.
 */
describe("SECRET_PATTERNS regression fixtures", () => {
  const MUST_REDACT: Array<[string, string, string]> = [
    [
      "kimi ak- key and org id",
      '{"message":"Your account org-0123456789abcdef <ak-EXAMPLEKEY01234567890> is suspended"}',
      "EXAMPLEKEY01234567890",
    ],
    ["openai-style sk-proj key", "Incorrect API key provided: sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123", "AbCdEfGhIjKlMnOpQrStUvWxYz0123"],
    ["bare bearer token", "Invalid Authorization: Bearer 8f3c1d9e7b5a4c2f6e8d0b1a3c5e7f9d", "8f3c1d9e7b5a4c2f6e8d0b1a3c5e7f9d"],
    ["assignment-style apikey", "GET /v1/search?api_key=ABCDEFGHIJKLMNOPQRSTUV failed", "ABCDEFGHIJKLMNOPQRSTUV"],
    [
      "zhipu id.secret key (documented format)",
      '{"error":{"code":"1002","message":"API key 1234567890abcdef1234567890abcdef.ABCDEFGHIJKLMNOPQRSTUVWXYZ1234 invalid"}}',
      "1234567890abcdef1234567890abcdef",
    ],
    [
      "dot-form key without a keyword nearby",
      "无效的令牌: 9876543210fedcba9876543210fedcba.A1B2C3D4E5F6G7H8I9J0K1L2",
      "9876543210fedcba9876543210fedcba",
    ],
    [
      "dot-form key inside a json body",
      '{"error":{"message":"invalid key 1a2b3c4d5e6f70819a2b3c4d5e6f7081.aabbccdd11223344"}}',
      "aabbccdd11223344",
    ],
  ];

  it.each(MUST_REDACT)("redacts %s", (_label, sample, secret) => {
    const out = redactSecrets(sample);
    expect(out).not.toContain(secret);
    // The matched span is shortened, not deleted: a bare "***" would also pass
    // if the whole sample were being swallowed.
    expect(out).toContain("***");
    expect(out.length).toBeLessThan(sample.length);
  });

  const MUST_KEEP: Array<[string, string]> = [
    ["ordinary prose", "the peak-performance run finished"],
    ["a channel base url", "GET https://api.moonshot.cn/v1/chat/completions failed"],
    ["the zhipu base url", "GET https://open.bigmodel.cn/api/paas/v4/web_search failed"],
    ["the kimi fiber path", "POST /v1/formulas/moonshot/web-search:latest/fibers failed"],
    ["a github url", "https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md"],
    ["a long hostname", "GET thisisareallylongdomainname.thelandofexampledomains failed"],
    ["a size complaint", "response body too large: over the 8388608 byte limit"],
    ["a date", "published 2026-09-15T08:30:00+08:00"],
    ["a dependency list", "package.json devDependencies vitest coverage-v8 typescript tsx"],
    ["a provider audit line", "all configured providers failed: kimi=timeout(30000ms); mimo=permanent_error"],
  ];

  it.each(MUST_KEEP)("leaves %s intact", (_label, sample) => {
    expect(redactSecrets(sample)).toBe(sample);
  });
});
