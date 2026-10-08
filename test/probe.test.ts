/**
 * @file test/probe
 * @description Probe module unit tests: success/failure/timeout all produce data
 * rows, sequential probing preserves input order.
 */

import { describe, expect, it } from 'vitest';
import { probeAll, probeProvider } from '../src/probe.js';
import { createRuntime } from '../src/runtime.js';
import type {
  FetchLike, NormalizedSearchResult, SearchContext, SearchProvider, SearchRequest,
} from '../src/types.js';

const req: SearchRequest = { query: 'q', count: 3 };

function provider(
  name: string,
  behavior: (r: SearchRequest, ctx: SearchContext) => Promise<NormalizedSearchResult>,
): SearchProvider {
  return { name, search: behavior };
}

function ok(name: string, titles: string[]): Promise<NormalizedSearchResult> {
  return Promise.resolve({
    results: titles.map((t) => ({ title: t, url: `https://${name}.example`, snippet: '' })),
    _meta: { provider: name, total_latency_ms: 0, attempts: [] },
  });
}

describe('probeProvider', () => {
  it('reports a successful probe with latency, count and first title', async () => {
    const row = await probeProvider(provider('a', () => ok('a', ['First title', 'Second'])), req, {
      timeoutMs: 1_000,
    });
    expect(row).toMatchObject({
      provider: 'a', ok: true, results: 2, sample: 'First title', error: '',
    });
    expect(row.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('reports an empty but successful search honestly', async () => {
    const row = await probeProvider(provider('a', () => ok('a', [])), req, { timeoutMs: 1_000 });
    expect(row).toMatchObject({ ok: true, results: 0, sample: '(no results)' });
  });

  it('converts a failure into a data row instead of throwing', async () => {
    const row = await probeProvider(
      provider('b', () => Promise.reject(new Error('fetch failed'))),
      req,
      { timeoutMs: 1_000 },
    );
    expect(row.ok).toBe(false);
    expect(row.error).toContain('fetch failed');
    expect(row.results).toBe(0);
  });

  it('honours its own timeout for hung providers', async () => {
    const hung = provider(
      'c',
      (_r, ctx) => new Promise<NormalizedSearchResult>((_res, reject) => {
        ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    );
    const row = await probeProvider(hung, req, { timeoutMs: 30 });
    expect(row.ok).toBe(false);
    expect(row.error).toContain('aborted');
  });

  it('truncates a very long first title in the sample field', async () => {
    const row = await probeProvider(provider('a', () => ok('a', ['T'.repeat(100)])), req, { timeoutMs: 1_000 });
    expect(row.sample).toHaveLength(60);
  });

  it('reports its own timeout with the shared timeout error type', async () => {
    // An adapter forwards the signal and rethrows its reason, so a probe timeout
    // must surface as the same TimeoutError as every other layer.
    const hung = provider(
      'd',
      (_r, ctx) => new Promise<NormalizedSearchResult>((_res, reject) => {
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
      }),
    );
    const row = await probeProvider(hung, req, { timeoutMs: 30 });
    expect(row.ok).toBe(false);
    expect(row.error).toBe('TimeoutError: request timed out');
  });

  it('never reports ok for an answer that arrives after its own deadline', async () => {
    // A channel that ignores the signal must not be reported healthy: the row
    // says the call worked and `test` exits 0, hiding a channel that is already
    // blowing the budget every single time.
    const late = provider('e', async () => {
      await new Promise<void>((res) => {
        setTimeout(res, 80);
      });
      return { results: [{ title: 'late', url: 'https://e.example', snippet: '' }], _meta: { provider: 'e', total_latency_ms: 0, attempts: [] } };
    });
    const row = await probeProvider(late, req, { timeoutMs: 20 });
    expect(row.ok).toBe(false);
    expect(row.results).toBe(0);
    expect(row.error).toBe('TimeoutError: request timed out');
  });
});

describe('probeAll', () => {
  it('probes every provider sequentially and preserves order', async () => {
    const order: string[] = [];
    const make = (name: string, fail = false): SearchProvider => provider(name, () => {
      order.push(name);
      return fail ? Promise.reject(new Error(`${name} down`)) : ok(name, [`${name} title`]);
    });
    const rows = await probeAll([make('a'), make('b', true), make('c')], req, { timeoutMs: 1_000 });
    expect(rows.map((r) => r.provider)).toEqual(['a', 'b', 'c']);
    expect(rows.map((r) => r.ok)).toEqual([true, false, true]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty list for an empty provider list', async () => {
    expect(await probeAll([], req, { timeoutMs: 100 })).toEqual([]);
  });
});

/**
 * The `npm run smoke` path, without the network.
 *
 * scripts/smoke.ts assembles a runtime and hands the ready chain to probeAll; it
 * is the only place that code path is exercised, it needs real keys, and it is
 * therefore not in CI at all — a wiring mistake there (a provider that never
 * reaches probeAll, a probe that throws instead of reporting a row, a broken
 * adapter) would only be discovered against live upstreams. probe.ts already
 * takes an injected fetch, so the same call can be driven offline: this drives
 * the real adapters built by the real runtime with synthetic keys.
 *
 * createRuntime is given `env` directly and never loads .env, so the project's
 * real credentials cannot reach this test; the keys below are invented.
 */
describe('probeAll over the real adapters', () => {
  const SYNTHETIC_ENV: NodeJS.ProcessEnv = {
    KIMI_API_KEY: 'SYNTHETIC-KIMI-KEY-000000000000',
    MIMO_API_KEY: 'SYNTHETIC-MIMO-KEY-000000000000',
    STEPFUN_API_KEY: 'SYNTHETIC-STEPFUN-KEY-000000000',
    ZHIPU_API_KEY: 'SYNTHETIC-ZHIPU-KEY-0000000000',
  };

  /**
   * One frozen success body per channel host, dispatching on the host so an
   * unrouted URL is a loud routing bug rather than a silent empty answer.
   * `status` lets a test fail exactly one slot.
   */
  function routingFetch(status: (url: string) => number = () => 200): FetchLike {
    let kimiChats = 0;
    return async (url) => {
      const code = status(url);
      if (code >= 400) return new Response('{"error":{"message":"synthetic failure"}}', { status: code });

      let host = '';
      let pathname = '';
      try {
        const parsed = new URL(url);
        host = parsed.host;
        pathname = parsed.pathname;
      } catch {
        // Keep defaults; unknown/invalid URLs should fall through to fixture miss.
      }

      if (host === 'api.moonshot.cn') {
        if (pathname.includes('/formulas/')) {
          return new Response(JSON.stringify({ context: { encrypted_output: 'E', references: ['https://k.example/1'] } }));
        }
        // Kimi asks for a tool first and gets the answer on the next chat turn.
        kimiChats += 1;
        const message = kimiChats === 1
          ? { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{}' } }] }
          : { role: 'assistant', content: 'kimi answer' };
        return new Response(JSON.stringify({ choices: [{ message }] }));
      }
      if (host === 'xiaomimimo') {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'mimo answer', annotations: [{ type: 'url_citation', title: 'mimo hit', url: 'https://m.example/1' }] } }],
          }),
        );
      }
      if (host === 'api.stepfun.com') {
        return new Response(JSON.stringify({ results: [{ title: 'stepfun hit', url: 'https://s.example/1' }] }));
      }
      if (host === 'open.bigmodel.cn') {
        return new Response(
          JSON.stringify({ search_result: [{ title: 'zhipu hit', link: 'https://z.example/1', content: 'c' }] }),
        );
      }
      throw new Error(`no fixture for ${url}`);
    };
  }

  it('reports one healthy row per ready channel from the assembled runtime', async () => {
    const runtime = createRuntime({ env: SYNTHETIC_ENV, warn: () => {}, fileExists: () => false });
    expect(runtime.chain.map((p) => p.name)).toEqual(['kimi', 'mimo', 'stepfun', 'zhipu']);

    const rows = await probeAll(
      runtime.chain,
      { query: 'synthetic probe', count: 3 },
      { timeoutMs: 1_000, fetchImpl: routingFetch() },
    );

    expect(rows.map((r) => r.provider)).toEqual(['kimi', 'mimo', 'stepfun', 'zhipu']);
    expect(rows.map((r) => [r.provider, r.ok, r.error])).toEqual([
      ['kimi', true, ''],
      ['mimo', true, ''],
      ['stepfun', true, ''],
      ['zhipu', true, ''],
    ]);
    // Each adapter's own result shape has to survive the probe and be counted.
    expect(rows.map((r) => r.results)).toEqual([1, 1, 1, 1]);
    expect(rows.find((r) => r.provider === 'kimi')!.sample).toBe('k.example');
    expect(rows.find((r) => r.provider === 'mimo')!.sample).toBe('mimo hit');
  });

  it('turns an upstream outage into a failing row, never a thrown error', async () => {
    // The whole point of a probe is to find the broken channel: an HTTP 5xx on
    // one slot must come back as ok=false carrying the diagnosis, while the
    // others stay green, or the table cannot say which slot is down.
    const runtime = createRuntime({ env: SYNTHETIC_ENV, warn: () => {}, fileExists: () => false });
    const rows = await probeAll(runtime.chain, { query: 'synthetic probe', count: 3 }, {
      timeoutMs: 1_000,
      fetchImpl: routingFetch((url) => (url.includes('api.stepfun.com') ? 503 : 200)),
    });

    const stepfun = rows.find((r) => r.provider === 'stepfun')!;
    expect(stepfun.ok).toBe(false);
    expect(stepfun.results).toBe(0);
    expect(stepfun.error).toContain('HTTP 503');
    expect(rows.filter((r) => r.ok)).toHaveLength(3);
  });

  it('reports a protocol break as a failed row instead of an empty success', async () => {
    // A renamed upstream container degrades to ParseError inside the adapter;
    // the probe must surface that as unhealthy rather than as "ok, 0 results",
    // which is the one reading an operator would act on wrongly.
    const runtime = createRuntime({ env: SYNTHETIC_ENV, warn: () => {}, fileExists: () => false });
    const inner = routingFetch();
    const rows = await probeAll(runtime.chain, { query: 'synthetic probe', count: 3 }, {
      timeoutMs: 1_000,
      fetchImpl: async (url, init) => (url.includes('api.stepfun.com')
        ? new Response(JSON.stringify({ hits: [] }))
        : inner(url, init)),
    });

    const stepfun = rows.find((r) => r.provider === 'stepfun')!;
    expect(stepfun.ok).toBe(false);
    expect(stepfun.error).toContain('ParseError');
    expect(stepfun.results).toBe(0);
    expect(rows.filter((r) => r.ok)).toHaveLength(3);
  });
});
