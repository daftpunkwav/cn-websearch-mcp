/**
 * @file test/normalize
 * @description Normalization helper unit tests: clamping, truncation, date/URL normalization,
 * shape assertions, and multi-source merging (canonicalUrl / mergeItems / mergeSourceItems).
 */

import { describe, expect, it } from "vitest";
import {
  asArray,
  asObject,
  canonicalUrl,
  clampInt,
  hostnameOf,
  maybeObject,
  mergeItems,
  mergeSourceItems,
  normalizeDate,
  toItem,
  truncate,
} from "../src/normalize.js";
import { ParseError } from "../src/errors.js";

describe("hostnameOf", () => {
  it("extracts the hostname and tolerates garbage", () => {
    expect(hostnameOf("https://example.com/a?b=1")).toBe("example.com");
    expect(hostnameOf("not a url")).toBe("");
  });
});

describe("clampInt", () => {
  it("clamps and falls back", () => {
    expect(clampInt(12, 8, 1, 10)).toBe(10);
    expect(clampInt(0, 8, 1, 10)).toBe(1);
    expect(clampInt("7", 8, 1, 10)).toBe(7);
    expect(clampInt(undefined, 8, 1, 10)).toBe(8);
    expect(clampInt("abc", 8, 1, 10)).toBe(8);
  });
});

describe("truncate / normalizeDate", () => {
  it("truncates long strings", () => {
    expect(truncate("abcdef", 3)).toBe("abc");
    expect(truncate("ab", 3)).toBe("ab");
  });
  it("normalizes dates", () => {
    expect(normalizeDate(" 2024-05-01 ")).toBe("2024-05-01");
    expect(normalizeDate(1700000000)).toBe("2023-11-14T22:13:20.000Z");
    expect(normalizeDate("")).toBeUndefined();
    expect(normalizeDate(null)).toBeUndefined();
    expect(normalizeDate(Infinity)).toBeUndefined(); // non-finite number → falls through
    expect(normalizeDate(42.5)).toBe("1970-01-01T00:00:42.500Z"); // fractional seconds are a valid date too
    expect(normalizeDate(1e21)).toBeUndefined(); // finite but outside the Date range → toISOString throws
    expect(normalizeDate(NaN)).toBeUndefined(); // fails the finiteness check
    expect(normalizeDate({ obj: true })).toBeUndefined(); // neither a string nor a number
  });
});

describe("toItem", () => {
  it("fills title from hostname when missing and keeps optional fields", () => {
    const item = toItem({ url: "example.com/x", content: "full text", published_date: "2024-05-01" });
    expect(item).toEqual({
      title: "example.com",
      url: "https://example.com/x",
      snippet: "",
      content: "full text",
      published_date: "2024-05-01",
    });
  });

  it("drops entries without a URL instead of fabricating one", () => {
    expect(toItem({ title: "no url" })).toBeNull();
    expect(toItem({ url: "  " })).toBeNull();
  });

  it("keeps non-http(s) scheme URLs as-is instead of prefixing https://", () => {
    expect(toItem({ url: "ftp://files.example/f" })).toEqual({
      title: "files.example",
      url: "ftp://files.example/f",
      snippet: "",
    });
  });
});

describe("asObject / asArray", () => {
  it("throws ParseError with context on shape mismatch", () => {
    expect(() => asObject(null, "response")).toThrow(ParseError);
    expect(() => asObject([1], "response")).toThrow(ParseError);
    expect(() => asArray({}, "results")).toThrow(ParseError);
    expect(asArray([1, 2], "results")).toEqual([1, 2]);
  });
});

describe("maybeObject", () => {
  it("returns objects and undefined for everything else", () => {
    expect(maybeObject({ a: 1 })).toEqual({ a: 1 });
    expect(maybeObject([1])).toBeUndefined();
    expect(maybeObject(null)).toBeUndefined();
    expect(maybeObject("x")).toBeUndefined();
    expect(maybeObject(undefined)).toBeUndefined();
  });
});

describe("canonicalUrl", () => {
  it("strips fragments, tracking params and a bare root trailing slash", () => {
    expect(canonicalUrl("https://a.example/x#frag")).toBe("https://a.example/x");
    expect(canonicalUrl("https://a.example/x?utm_source=wx&id=1")).toBe("https://a.example/x?id=1");
    expect(canonicalUrl("https://a.example/")).toBe("https://a.example");
    expect(canonicalUrl("https://a.example")).toBe("https://a.example");
  });

  it("keeps meaningful params and path case", () => {
    expect(canonicalUrl("https://a.example/Path?q=1")).toBe("https://a.example/Path?q=1");
  });

  it("returns the trimmed input when the URL cannot be parsed", () => {
    expect(canonicalUrl("  not a url  ")).toBe("not a url");
  });
});

describe("mergeItems", () => {
  it("keeps the first title/url/source and the richer snippet, content and date", () => {
    const merged = mergeItems(
      { title: "first", url: "https://a.example/1", snippet: "short", source: "kimi" },
      {
        title: "second",
        url: "https://a.example/1",
        snippet: "a much longer snippet",
        content: "body",
        published_date: "2026-01-01",
        source: "zhipu",
      },
    );
    expect(merged).toEqual({
      title: "first",
      url: "https://a.example/1",
      snippet: "a much longer snippet",
      content: "body",
      published_date: "2026-01-01",
      source: "kimi",
    });
  });

  it("falls back to the second entry when the first lacks a title or date", () => {
    const merged = mergeItems(
      { title: "", url: "https://a.example/1", snippet: "" },
      { title: "second", url: "https://a.example/1", snippet: "", published_date: "2026-02-02" },
    );
    expect(merged.title).toBe("second");
    expect(merged.published_date).toBe("2026-02-02");
    expect(merged.source).toBeUndefined();
  });
});

describe("mergeSourceItems", () => {
  const sources = [
    { provider: "kimi", items: [{ title: "k", url: "https://a.example/1?utm_source=x", snippet: "s" }] },
    { provider: "zhipu", items: [{ title: "z", url: "https://a.example/1", snippet: "longer snippet" }] },
  ];

  it("attributes every item to its provider when dedupe is off", () => {
    expect(mergeSourceItems(sources, false)).toEqual([
      { title: "k", url: "https://a.example/1?utm_source=x", snippet: "s", source: "kimi" },
      { title: "z", url: "https://a.example/1", snippet: "longer snippet", source: "zhipu" },
    ]);
  });

  it("merges the same resource across providers, keeping priority order", () => {
    const merged = mergeSourceItems(sources, true);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ title: "k", source: "kimi", snippet: "longer snippet" });
  });

  it("keeps distinct URLs separate and preserves an existing source tag", () => {
    const merged = mergeSourceItems([
      { provider: "kimi", items: [{ title: "a", url: "https://a.example/1", snippet: "", source: "preset" }] },
      { provider: "zhipu", items: [{ title: "b", url: "https://b.example/2", snippet: "" }] },
    ]);
    expect(merged.map((i) => i.source)).toEqual(["preset", "zhipu"]);
  });

  it("defaults to deduping (third argument omitted)", () => {
    expect(mergeSourceItems(sources)).toHaveLength(1);
  });
});
