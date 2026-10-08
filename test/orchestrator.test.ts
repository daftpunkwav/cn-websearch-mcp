/**
 * @file test/orchestrator
 * @description Orchestration layer unit tests: retries with backoff, caller
 * cancellation, fallback, timeout circuit-breaking, multi-source aggregation
 * and strategy dispatch.
 */

import { describe, expect, it } from 'vitest';
import { getEventListeners } from 'node:events';
import {
  AllProvidersFailedError,
  CallCancelledError,
  NoProviderConfiguredError,
  runSearch,
  searchAggregate,
  searchWithFallback,
} from '../src/orchestrator.js';
import { HttpError, NetworkError, TimeoutError } from '../src/errors.js';
import type {
  NormalizedSearchResult, SearchContext, SearchProvider, SearchRequest,
} from '../src/types.js';

const req: SearchRequest = { query: 'q', count: 8 };
const opts = { timeoutMs: 1_000 };

/** Far above the 250ms retry backoff: passing it proves no retry was attempted. */
const RETRY_BUDGET_MS = 200;

function makeProvider(
  name: string,
  behavior: (
    req: SearchRequest, ctx: SearchContext, call: number,
  ) => Promise<NormalizedSearchResult>,
): { provider: SearchProvider; calls: () => number } {
  let n = 0;
  return {
    provider: {
      name,
      search: async (r, c) => {
        n += 1;
        return behavior(r, c, n);
      },
    },
    calls: () => n,
  };
}

function okResult(provider: string, items = 1): NormalizedSearchResult {
  return {
    results: Array.from({ length: items }, (_, i) => ({ title: `${provider}-${i}`, url: `https://${provider}.example/${i}`, snippet: '' })),
    _meta: { provider, total_latency_ms: 0, attempts: [] },
  };
}

/** One-provider fallback search on the caller's signal, with the rejection captured. */
function cancelledSearch(provider: SearchProvider, signal: AbortSignal): Promise<unknown> {
  return searchWithFallback(req, { ...opts, providers: [provider], signal }).catch((e) => e);
}

/** Provider that answers 'a' only 5ms after `controller` aborts: the late answer. */
function makeLateProvider(
  controller: AbortController,
): { provider: SearchProvider; calls: () => number } {
  return makeProvider('a', (_r, ctx) => new Promise<NormalizedSearchResult>((resolve) => {
    ctx.signal.addEventListener('abort', () => {
      setTimeout(() => resolve(okResult('a')), 5);
    });
    controller.abort();
  }));
}

/** Provider whose first call fails with a 429 after running `onFirstCall`. */
function makeRateLimitedProvider(
  onFirstCall: () => void,
): { provider: SearchProvider; calls: () => number } {
  return makeProvider('a', async (_r, _c, call) => {
    if (call === 1) {
      onFirstCall();
      throw new HttpError(429, 'HTTP 429: slow down');
    }
    return okResult('a');
  });
}

describe('errors', () => {
  it('AllProvidersFailedError renders an empty trail when nothing was attempted', () => {
    expect(new AllProvidersFailedError([]).message).toBe('all configured providers failed: ');
  });

  it('NoProviderConfiguredError has an actionable message', () => {
    expect(new NoProviderConfiguredError().message).toContain('no provider is configured');
  });

  it('every structured failure carries an audit trail, even an empty one', () => {
    // One shape for all three, so the tool layer renders them without probing
    // the error type and never has to invent an empty list at the call site.
    expect(new NoProviderConfiguredError().attempts).toEqual([]);
    expect(new AllProvidersFailedError([]).attempts).toEqual([]);
    expect(new CallCancelledError([]).attempts).toEqual([]);
  });
});

describe('searchWithFallback', () => {
  it('throws NoProviderConfiguredError when the chain is empty', async () => {
    await expect(searchWithFallback(req, { ...opts, providers: [] })).rejects.toBeInstanceOf(
      NoProviderConfiguredError,
    );
  });

  it("returns the first provider's result without calling the rest", async () => {
    const a = makeProvider('a', async () => okResult('a'));
    const b = makeProvider('b', async () => okResult('b'));
    const out = await searchWithFallback(req, { ...opts, providers: [a.provider, b.provider] });
    expect(out._meta.provider).toBe('a');
    expect(b.calls()).toBe(0);
    expect(out._meta.attempts).toEqual([{ provider: 'a', status: 'ok', latency_ms: expect.any(Number) }]);
    expect(out.results).toHaveLength(1);
  });

  it('retries once after a transient 500, then succeeds', async () => {
    const a = makeProvider('a', async (_r, _c, call) => {
      if (call === 1) throw new HttpError(500, 'HTTP 500: boom');
      return okResult('a');
    });
    const out = await searchWithFallback(req, { ...opts, providers: [a.provider] });
    expect(a.calls()).toBe(2);
    expect(out._meta.attempts.map((x) => x.status)).toEqual(['transient_error', 'ok']);
  });

  it('retries once after a network error, then falls through on second failure', async () => {
    const a = makeProvider('a', async () => {
      throw new NetworkError('fetch failed');
    });
    const b = makeProvider('b', async () => okResult('b'));
    const out = await searchWithFallback(req, { ...opts, providers: [a.provider, b.provider] });
    expect(a.calls()).toBe(2);
    expect(out._meta.provider).toBe('b');
    expect(out._meta.attempts.map((x) => x.provider)).toEqual(['a', 'a', 'b']);
  });

  it('does not retry permanent 4xx errors', async () => {
    const a = makeProvider('a', async () => {
      throw new HttpError(401, 'HTTP 401: bad key');
    });
    const b = makeProvider('b', async () => okResult('b'));
    const out = await searchWithFallback(req, { ...opts, providers: [a.provider, b.provider] });
    expect(a.calls()).toBe(1);
    expect(out._meta.provider).toBe('b');
    expect(out._meta.attempts[0]).toMatchObject({ provider: 'a', status: 'permanent_error' });
  });

  it('aborts a hung provider at the timeout and falls through', async () => {
    const a = makeProvider(
      'a',
      (_r, ctx) => new Promise<NormalizedSearchResult>((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
      }),
    );
    const b = makeProvider('b', async () => okResult('b'));
    const out = await searchWithFallback(req, {
      ...opts, providers: [a.provider, b.provider], timeoutMs: 50,
    });
    expect(out._meta.provider).toBe('b');
    expect(out._meta.attempts[0]).toMatchObject({ provider: 'a', status: 'timeout' });
  });

  it('throws AllProvidersFailedError carrying every attempt when all fail', async () => {
    const a = makeProvider('a', async () => {
      throw new HttpError(401, 'HTTP 401');
    });
    const b = makeProvider('b', async () => {
      throw new TimeoutError();
    });
    const err = await searchWithFallback(req, {
      ...opts, providers: [a.provider, b.provider],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    // A timeout is reported as "timeout" and never retried, no matter whether the
    // budget timer or the adapter raised it: the same hung request must get the
    // same verdict, and it must not spend a second budget.
    expect((err as AllProvidersFailedError).attempts.map((x) => `${x.provider}:${x.status}`)).toEqual([
      'a:permanent_error',
      'b:timeout',
    ]);
    expect(b.calls()).toBe(1);
  });

  it('does not retry a timeout raised by the adapter itself', async () => {
    const a = makeProvider('a', async () => {
      throw new TimeoutError('upstream deadline');
    });
    const b = makeProvider('b', async () => okResult('b'));
    const t0 = Date.now();
    const out = await searchWithFallback(req, { ...opts, providers: [a.provider, b.provider] });
    expect(a.calls()).toBe(1);
    expect(out._meta.provider).toBe('b');
    expect(out._meta.attempts[0]).toMatchObject({ provider: 'a', status: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(RETRY_BUDGET_MS);
  });

  it('keeps empty results as a legitimate success', async () => {
    const a = makeProvider('a', async () => okResult('a', 0));
    const out = await searchWithFallback(req, { ...opts, providers: [a.provider] });
    expect(out.results).toEqual([]);
    expect(out._meta.provider).toBe('a');
    expect(out._meta.providers).toEqual(['a']);
  });
});

describe('searchAggregate', () => {
  it('queries every provider and merges their items', async () => {
    const a = makeProvider('a', async () => okResult('a', 2));
    const b = makeProvider('b', async () => okResult('b', 2));
    const out = await searchAggregate(req, { ...opts, providers: [a.provider, b.provider] });
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
    expect(out.results).toHaveLength(4);
    expect(out._meta.provider).toBe('a');
    expect(out._meta.providers).toEqual(['a', 'b']);
    expect(out._meta.attempts.map((x) => `${x.provider}:${x.status}`)).toEqual(['a:ok', 'b:ok']);
  });

  it('returns partial results when only some providers fail', async () => {
    const dead = makeProvider('dead', async () => {
      throw new HttpError(401, 'HTTP 401: bad key');
    });
    const alive = makeProvider('alive', async () => okResult('alive', 1));
    const out = await searchAggregate(req, { ...opts, providers: [dead.provider, alive.provider] });
    expect(out._meta.providers).toEqual(['alive']);
    expect(out.results).toHaveLength(1);
    // Failure details remain in the audit trail for debugging.
    expect(out._meta.attempts[0]).toMatchObject({ provider: 'dead', status: 'permanent_error' });
  });

  it('throws AllProvidersFailedError when nobody answers', async () => {
    const a = makeProvider('a', async () => {
      throw new HttpError(500, 'HTTP 500: boom');
    });
    const err = await searchAggregate(req, { ...opts, providers: [a.provider] }).catch((e) => e);
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    // Transient errors retry once.
    expect((err as AllProvidersFailedError).attempts).toHaveLength(2);
  });

  it('throws NoProviderConfiguredError for an empty provider list', async () => {
    await expect(searchAggregate(req, { ...opts, providers: [] })).rejects.toBeInstanceOf(
      NoProviderConfiguredError,
    );
  });

  it('dedupes the same URL across providers by default, keeping priority order', async () => {
    const a = makeProvider('a', async () => ({
      results: [{ title: 'a-title', url: 'https://same.example/1?utm_source=a', snippet: 'short' }],
      _meta: { provider: 'a', total_latency_ms: 0, attempts: [] },
    }));
    const b = makeProvider('b', async () => ({
      results: [{ title: 'b-title', url: 'https://same.example/1', snippet: 'a longer snippet' }],
      _meta: { provider: 'b', total_latency_ms: 0, attempts: [] },
    }));
    const out = await searchAggregate(req, { ...opts, providers: [a.provider, b.provider] });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({
      title: 'a-title',
      source: 'a',
      snippet: 'a longer snippet',
    });
  });

  it('keeps duplicates when dedupe is disabled, tagging each source', async () => {
    const a = makeProvider('a', async () => ({
      results: [{ title: 'a', url: 'https://same.example/1', snippet: '' }],
      _meta: { provider: 'a', total_latency_ms: 0, attempts: [] },
    }));
    const b = makeProvider('b', async () => ({
      results: [{ title: 'b', url: 'https://same.example/1', snippet: '' }],
      _meta: { provider: 'b', total_latency_ms: 0, attempts: [] },
    }));
    const out = await searchAggregate(req, {
      ...opts, providers: [a.provider, b.provider], dedupe: false,
    });
    expect(out.results.map((r) => r.source)).toEqual(['a', 'b']);
  });

  it('caps the merged list at the requested count', async () => {
    const a = makeProvider('a', async () => okResult('a', 5));
    const b = makeProvider('b', async () => okResult('b', 5));
    const out = await searchAggregate({ query: 'q', count: 3 }, { ...opts, providers: [a.provider, b.provider] });
    expect(out.results).toHaveLength(3);
  });

  it('labels synthesized answers per provider when several respond with one', async () => {
    const withAnswer = (name: string, answer: string): SearchProvider => ({
      name,
      search: async () => ({
        results: [],
        _meta: {
          provider: name, total_latency_ms: 0, attempts: [], answer,
        },
      }),
    });
    const out = await searchAggregate(req, { ...opts, providers: [withAnswer('a', 'A says'), withAnswer('b', 'B says')] });
    expect(out._meta.answer).toBe('[a] A says\n\n[b] B says');
  });

  it('returns a single answer unlabelled and omits the field when there is none', async () => {
    const one: SearchProvider = {
      name: 'a',
      search: async () => ({
        results: [],
        _meta: {
          provider: 'a', total_latency_ms: 0, attempts: [], answer: 'only',
        },
      }),
    };
    const silent = makeProvider('b', async () => okResult('b', 1));
    expect((await searchAggregate(req, { ...opts, providers: [one] }))._meta.answer).toBe('only');
    expect((await searchAggregate(req, { ...opts, providers: [silent.provider, one] }))._meta.answer).toBe('only');
    const noAnswer = await searchAggregate(req, { ...opts, providers: [silent.provider] });
    expect(noAnswer._meta.answer).toBeUndefined();
  });
});

describe('caller cancellation', () => {
  it('aborts the in-flight attempt and stops walking the chain', async () => {
    const controller = new AbortController();
    const a = makeProvider(
      'a',
      (_r, ctx) => new Promise<NormalizedSearchResult>((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
        setTimeout(() => controller.abort(), 5);
      }),
    );
    const b = makeProvider('b', async () => okResult('b'));
    const err = await searchWithFallback(req, {
      ...opts,
      providers: [a.provider, b.provider],
      signal: controller.signal,
    }).catch((e) => e);
    // A client that walked away is not a provider outage, so it must not be
    // reported as AllProvidersFailedError, and the chain must not continue.
    expect(err).toBeInstanceOf(CallCancelledError);
    expect(b.calls()).toBe(0);
  });

  it('records a cancelled attempt in the audit trail it carries', async () => {
    const controller = new AbortController();
    controller.abort();
    const a = makeProvider('a', async () => okResult('a'));
    const err = await cancelledSearch(a.provider, controller.signal);
    expect(err).toBeInstanceOf(CallCancelledError);
    // The audit trail must survive the cancellation, otherwise the caller is
    // told "cancelled" with no record of what was in flight.
    expect((err as CallCancelledError).attempts).toEqual([
      { provider: 'a', status: 'cancelled', latency_ms: 0 },
    ]);
  });

  it('reports cancellation instead of an all-failed aggregate', async () => {
    const controller = new AbortController();
    const dead = makeProvider('dead', async () => {
      controller.abort();
      throw new HttpError(500, 'HTTP 500: boom');
    });
    const err = await searchAggregate(req, {
      ...opts, providers: [dead.provider], signal: controller.signal,
    }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(CallCancelledError);
    expect(err).not.toBeInstanceOf(AllProvidersFailedError);
  });

  it('never echoes the abort reason, which is supplied by the peer', async () => {
    const controller = new AbortController();
    controller.abort('client supplied \u001b[31m text');
    const a = makeProvider('a', async () => okResult('a'));
    const err = await cancelledSearch(a.provider, controller.signal);
    expect((err as Error).message).toBe('search cancelled by the caller');
  });

  it('still succeeds normally when no signal is supplied', async () => {
    const a = makeProvider('a', async () => okResult('a'));
    const out = await searchWithFallback(req, { ...opts, providers: [a.provider] });
    expect(out._meta.provider).toBe('a');
  });

  it('does not hand a late answer to a caller that already cancelled', async () => {
    // A provider that answers anyway (a fetch that ignores the signal, or a
    // response landing on the budget boundary) must not turn a cancellation
    // into a success: fallback used to return the result, aggregate did not.
    const controller = new AbortController();
    const late = makeLateProvider(controller);
    const err = await cancelledSearch(late.provider, controller.signal);
    expect(err).toBeInstanceOf(CallCancelledError);
    expect((err as CallCancelledError).attempts.map((x) => x.status)).toEqual(['cancelled']);
  });

  it('reports a late answer the same way under aggregate', async () => {
    const controller = new AbortController();
    const late = makeLateProvider(controller);
    const err = await searchAggregate(req, {
      ...opts, providers: [late.provider], signal: controller.signal,
    }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(CallCancelledError);
    expect((err as CallCancelledError).attempts.map((x) => x.status)).toEqual(['cancelled']);
  });

  it("releases each attempt's abort listener before the retry backoff", async () => {
    // A 429 pays a 1s backoff. Halfway through it the finished attempt must
    // already be detached from the caller's signal; only the backoff wait's own
    // listener may still be attached.
    const controller = new AbortController();
    const a = makeProvider('a', async (_r, _c, call) => {
      if (call === 1) throw new HttpError(429, 'HTTP 429: slow down');
      return okResult('a');
    });
    const pending = searchWithFallback(req, {
      ...opts, providers: [a.provider], signal: controller.signal,
    });
    await new Promise((r) => {
      setTimeout(r, 300);
    });
    const attached = getEventListeners(controller.signal, 'abort').length;
    const out = await pending;
    expect(attached).toBe(1);
    expect(out._meta.attempts.map((x) => x.status)).toEqual(['transient_error', 'ok']);
  });
});

describe('transient retry backoff', () => {
  it('waits before the single retry instead of hammering a rate-limited upstream', async () => {
    const stamps: number[] = [];
    const a = makeProvider('a', async (_r, _c, call) => {
      stamps.push(Date.now());
      if (call === 1) throw new HttpError(429, 'HTTP 429: slow down');
      return okResult('a');
    });
    const t0 = Date.now();
    const out = await searchWithFallback(req, { ...opts, providers: [a.provider] });
    expect(out._meta.provider).toBe('a');
    expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(200);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('does not retry a permanent failure, so no backoff is paid', async () => {
    const a = makeProvider('a', async () => {
      throw new HttpError(401, 'HTTP 401: bad key');
    });
    const t0 = Date.now();
    await searchWithFallback(req, { ...opts, providers: [a.provider] }).catch(() => undefined);
    expect(a.calls()).toBe(1);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it('is cut short when the caller cancels during the backoff', async () => {
    // A non-abortable wait would strand the whole call for the full 429 delay.
    const controller = new AbortController();
    const a = makeRateLimitedProvider(() => {
      setTimeout(() => controller.abort(), 10);
    });
    const t0 = Date.now();
    const err = await cancelledSearch(a.provider, controller.signal);
    const elapsed = Date.now() - t0;
    expect(err).toBeInstanceOf(CallCancelledError);
    // The 429 backoff is 1s; finishing far below that proves the wait was cut short.
    expect(elapsed).toBeLessThan(500);
    // The first attempt keeps its own verdict; the second is the cancellation.
    expect((err as CallCancelledError).attempts.map((x) => x.status)).toEqual(['transient_error', 'cancelled']);
  });

  it('does not start a backoff at all when the caller already cancelled', async () => {
    // A provider that aborts the caller's signal before failing must not buy
    // the retry: the attempt is already recorded as cancelled, so there is no
    // backoff to wait out and no second call to make against a peer that left.
    const controller = new AbortController();
    const a = makeRateLimitedProvider(() => controller.abort());
    const t0 = Date.now();
    const err = await cancelledSearch(a.provider, controller.signal);
    expect(err).toBeInstanceOf(CallCancelledError);
    // Far below the 1s backoff a transient failure would have paid.
    expect(Date.now() - t0).toBeLessThan(500);
    // The cancellation is recorded as such, not as the transient failure the
    // provider happened to raise on its way out.
    expect((err as CallCancelledError).attempts.map((x) => x.status)).toEqual(['cancelled']);
    expect(a.calls()).toBe(1);
  });
});

describe('runSearch', () => {
  it('dispatches to the fallback strategy', async () => {
    const a = makeProvider('a', async () => okResult('a', 1));
    const b = makeProvider('b', async () => okResult('b', 1));
    const out = await runSearch(req, { ...opts, providers: [a.provider, b.provider], strategy: 'fallback' });
    expect(out._meta.provider).toBe('a');
    expect(b.calls()).toBe(0);
  });

  it('dispatches to the aggregate strategy', async () => {
    const a = makeProvider('a', async () => okResult('a', 1));
    const b = makeProvider('b', async () => okResult('b', 1));
    const out = await runSearch(req, { ...opts, providers: [a.provider, b.provider], strategy: 'aggregate' });
    expect(out._meta.providers).toEqual(['a', 'b']);
    expect(b.calls()).toBe(1);
  });

  it('caps the number of participating providers with maxProviders', async () => {
    const a = makeProvider('a', async () => okResult('a', 1));
    const b = makeProvider('b', async () => okResult('b', 1));
    const out = await runSearch(req, {
      ...opts,
      providers: [a.provider, b.provider],
      strategy: 'aggregate',
      maxProviders: 1,
    });
    expect(out._meta.providers).toEqual(['a']);
    expect(b.calls()).toBe(0);
  });

  it('throws NoProviderConfiguredError when the capped list is empty', async () => {
    await expect(runSearch(req, { ...opts, providers: [], strategy: 'fallback' })).rejects.toBeInstanceOf(
      NoProviderConfiguredError,
    );
  });

  it('honours a provider-specific timeout budget over the global one', async () => {
    const slow: SearchProvider = {
      name: 'slow',
      timeoutMs: 20,
      search: (_r, ctx) => new Promise<NormalizedSearchResult>((_res, reject) => {
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
      }),
    };
    const fast = makeProvider('fast', async () => okResult('fast', 1));
    const out = await runSearch(req, {
      providers: [slow, fast.provider],
      timeoutMs: 5_000,
      strategy: 'fallback',
    });
    expect(out._meta.attempts[0]).toMatchObject({ provider: 'slow', status: 'timeout' });
    expect(out._meta.provider).toBe('fast');
  });
});
