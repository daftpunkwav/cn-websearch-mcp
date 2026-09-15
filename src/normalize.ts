/**
 * @file normalize
 * @description Field normalization helpers shared by all adapters.
 *
 * Responsibilities:
 * - Coerce raw provider fields into normalized result items
 * - Numeric clamping, string truncation, date and URL normalization
 * - URL canonicalization and multi-source result merging (used by the aggregate strategy)
 * - Assert on payload shapes, throwing a readable ParseError with context on failure
 */

// Normalization helpers shared by the adapters. Every function is safe on
// garbage input: normalize what can be normalized, otherwise throw ParseError
// or return a fallback — never an unexpected exception.

import { ParseError } from "./errors.js";
import type { NormalizedItem } from "./types.js";

/** Best-effort hostname extraction; returns an empty string on parse failure. */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Clamp to an integer in [min, max]; returns fallback when not parseable as a finite number. */
export function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Truncate overlong strings to max characters. */
export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** Non-empty string dates pass through; numbers are treated as unix seconds and converted to ISO 8601. */
export function normalizeDate(d: unknown): string | undefined {
  if (typeof d === "string" && d.trim() !== "") return d.trim();
  if (typeof d === "number" && Number.isFinite(d)) {
    try {
      return new Date(d * 1000).toISOString();
    } catch {
      // toISOString throws RangeError when the number exceeds Date's range; treat as no date.
      return undefined;
    }
  }
  return undefined;
}

/** Assert that an unknown parsed value is a plain object; throws a contextual ParseError on failure. */
export function asObject(v: unknown, what: string): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  throw new ParseError(`${what}: expected object`);
}

/** Lenient object getter: always returns undefined for non-objects, never throws (for optional config values). */
export function maybeObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Assert that an unknown parsed value is an array; throws a contextual ParseError on failure. */
export function asArray(v: unknown, what: string): unknown[] {
  if (Array.isArray(v)) return v;
  throw new ParseError(`${what}: expected array`);
}

/** Safe string getter: returns an empty string for anything that is not a string. */
export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Normalize a raw search item into a NormalizedItem. `url` is required —
 * items without a URL are dropped outright, never fabricated. URLs already
 * carrying any scheme (http, https, ftp, ...) are kept as-is; only bare
 * host paths get the https:// prefix, so "ftp://x" is not mangled into
 * "https://ftp://x".
 */
export function toItem(raw: {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  content?: unknown;
  published_date?: unknown;
}): NormalizedItem | null {
  const url = str(raw.url).trim();
  if (!url) return null;
  const urlNorm = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
  const item: NormalizedItem = {
    title: str(raw.title).trim() || hostnameOf(urlNorm),
    url: urlNorm,
    snippet: str(raw.snippet).trim(),
  };
  const content = str(raw.content).trim();
  if (content) item.content = content;
  const date = normalizeDate(raw.published_date);
  if (date) item.published_date = date;
  return item;
}

/**
 * Common tracking/share parameters: the same article often yields multiple
 * distinct URLs because of them, so aggregate dedupe must ignore them.
 * Deliberately conservative — only well-known tracking keys are listed,
 * avoiding accidental removal of semantic parameters.
 */
const TRACKING_PARAM = /^(utm_|spm|scm$|share_|gclid$|fbclid$|_hs(enc|mi)$|mc_(cid|eid)$|ref$|ref_|fr$)/i;

/**
 * Produce the canonical form of a URL for dedupe: strip the fragment,
 * tracking parameters, and the trailing slash on the root path. Returns the
 * trimmed original when the URL cannot be parsed — prefer under-merging
 * to wrong merging.
 */
export function canonicalUrl(url: string): string {
  const raw = url.trim();
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
    }
    const out = u.toString();
    // "https://a.com/" and "https://a.com" are the same resource.
    return u.pathname === "/" && u.search === "" ? out.replace(/\/$/, "") : out;
  } catch {
    return raw;
  }
}

/**
 * Merge two items with the same URL, keeping the more informative one.
 * title/url follow the first arrival (the higher-priority provider);
 * snippet/content take the longer; published_date takes the first non-empty;
 * source keeps the first origin to preserve attributability.
 */
export function mergeItems(a: NormalizedItem, b: NormalizedItem): NormalizedItem {
  const longer = (x: string, y: string): string => (y.length > x.length ? y : x);
  const merged: NormalizedItem = {
    title: a.title || b.title,
    url: a.url,
    snippet: longer(a.snippet, b.snippet),
  };
  const content = longer(a.content ?? "", b.content ?? "");
  if (content) merged.content = content;
  const date = a.published_date ?? b.published_date;
  if (date) merged.published_date = date;
  const source = a.source ?? b.source;
  if (source) merged.source = source;
  return merged;
}

/**
 * Multi-source result merge. The order of `sources` is the priority order and
 * decides which entry wins as the primary body for the same URL. With dedupe
 * disabled, only source tags are added, no merging.
 */
export function mergeSourceItems(
  sources: Array<{ provider: string; items: NormalizedItem[] }>,
  dedupe = true,
): NormalizedItem[] {
  if (!dedupe) {
    return sources.flatMap((s) => s.items.map((item) => ({ ...item, source: item.source ?? s.provider })));
  }
  const seenAt = new Map<string, number>();
  const out: NormalizedItem[] = [];
  for (const s of sources) {
    for (const item of s.items) {
      const tagged: NormalizedItem = item.source ? item : { ...item, source: s.provider };
      const key = canonicalUrl(tagged.url);
      const at = seenAt.get(key);
      if (at === undefined) {
        seenAt.set(key, out.length);
        out.push(tagged);
      } else {
        out[at] = mergeItems(out[at]!, tagged);
      }
    }
  }
  return out;
}
