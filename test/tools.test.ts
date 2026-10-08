/**
 * @file test/tools
 * @description Tool layer unit tests: argument validation (strategy/provider subsets), defaults,
 * caller cancellation, redacted error output and dependency injection.
 */

import {
  describe, expect, it, vi,
} from 'vitest';
import { buildToolDefinitions, createGatewayTools, textContent } from '../src/tools.js';
import { AllProvidersFailedError } from '../src/orchestrator.js';
import { HttpError } from '../src/errors.js';
import { loadConfig } from '../src/config.js';
import type {
  AttemptRecord, NormalizedSearchResult, SearchProvider, SearchRequest,
} from '../src/types.js';

function fakeProvider(
  name: string,
  behavior?: (req: SearchRequest) => Promise<NormalizedSearchResult>,
): SearchProvider {
  return {
    name,
    search:
      behavior
      ?? (async () => ({
        results: [{ title: `${name} title`, url: `https://${name}.example`, snippet: '' }],
        _meta: { provider: name, total_latency_ms: 0, attempts: [] },
      })),
  };
}

const alive = (): SearchProvider => fakeProvider('stepfun');

function deps(
  chain: SearchProvider[],
  over: Partial<Parameters<typeof createGatewayTools>[0]> = {},
) {
  return {
    config: loadConfig({ env: { STEPFUN_API_KEY: 's', KIMI_API_KEY: 'k' }, warn: () => {} }),
    chain,
    ...over,
  };
}

function parse(out: { content: { type: string; text: string }[] }): any {
  return JSON.parse(out.content[0]!.text);
}

describe('buildToolDefinitions', () => {
  it('exposes exactly two tools and reflects the configured defaults', () => {
    const defs = buildToolDefinitions(12, 'aggregate');
    expect(defs.map((t) => t.name)).toEqual(['web_search', 'provider_status']);
    const search = defs[0].inputSchema.properties as Record<string, any>;
    expect(search.count!.default).toBe(12);
    expect(search.strategy!.default).toBe('aggregate');
    expect(search.strategy!.enum).toEqual(['fallback', 'aggregate']);
  });
});

describe('provider_status', () => {
  it('reports settings, per-provider flags and never echoes the API key', async () => {
    const tools = createGatewayTools(deps([alive()]));
    const out = await tools.call('provider_status', {});
    const body = parse(out);
    expect(body.strategy).toBe('fallback');
    expect(body.order).toEqual(['kimi', 'mimo', 'stepfun', 'zhipu']);
    expect(body.config_file).toBeNull();

    const byName = Object.fromEntries(body.providers.map((p: any) => [p.name, p]));
    expect(byName.stepfun).toMatchObject({
      enabled: true, configured: true, in_chain: true, priority: 0,
    });
    expect(byName.kimi).toMatchObject({ configured: true, in_chain: false });
    expect(byName.zhipu).toMatchObject({
      configured: false, in_chain: false, model: null, timeout_ms: null,
    });
    // Status output echoes only whether a key is configured, never the key itself.
    expect(out.content[0]!.text).not.toContain('"apiKey"');
    expect(out.content[0]!.text).not.toContain('s-key');
  });
});

describe('web_search argument validation', () => {
  it('rejects a missing or empty query', async () => {
    const tools = createGatewayTools(deps([alive()]));
    for (const args of [{}, { query: '' }, { query: '   ' }, { query: 42 }]) {
      const out = await tools.call('web_search', args);
      expect(out.isError).toBe(true);
      expect(parse(out).error).toContain("'query' must be a non-empty string");
    }
  });

  it('rejects an unknown strategy', async () => {
    const out = await createGatewayTools(deps([alive()])).call('web_search', { query: 'q', strategy: 'turbo' });
    expect(out.isError).toBe(true);
    expect(parse(out).error).toContain("'strategy' must be one of fallback, aggregate");
  });

  it('rejects a non-string strategy as well as an unknown one', async () => {
    const tools = createGatewayTools(deps([alive()]));
    for (const strategy of [42, null, ['fallback'], { name: 'fallback' }]) {
      const out = await tools.call('web_search', { query: 'q', strategy });
      expect(out.isError).toBe(true);
      expect(parse(out).error).toContain("'strategy' must be one of fallback, aggregate");
    }
  });

  it('rejects a malformed providers argument', async () => {
    const tools = createGatewayTools(deps([alive()]));
    for (const providers of ['stepfun', [1, 2], []]) {
      const out = await tools.call('web_search', { query: 'q', providers });
      expect(out.isError).toBe(true);
      expect(parse(out).error).toContain("'providers'");
    }
  });

  it('names unknown providers and unavailable ones explicitly', async () => {
    const tools = createGatewayTools(deps([alive()]));
    const unknown = parse(await tools.call('web_search', { query: 'q', providers: ['openai'] }));
    expect(unknown.error).toContain('unknown provider(s): openai');
    const missing = parse(await tools.call('web_search', { query: 'q', providers: ['zhipu'] }));
    expect(missing.error).toContain('provider(s) unavailable: zhipu');
  });

  it('trims and truncates an over-long query', async () => {
    let seen: SearchRequest | undefined;
    const p = fakeProvider('stepfun', async (req) => {
      seen = req;
      return { results: [], _meta: { provider: 'stepfun', total_latency_ms: 0, attempts: [] } };
    });
    await createGatewayTools(deps([p])).call('web_search', { query: `  ${'x'.repeat(500)}  ` });
    expect(seen!.query).toHaveLength(400);
  });

  it('clamps an out-of-range count and defaults it from config', async () => {
    const seen: number[] = [];
    const p = fakeProvider('stepfun', async (req) => {
      seen.push(req.count);
      return { results: [], _meta: { provider: 'stepfun', total_latency_ms: 0, attempts: [] } };
    });
    const tools = createGatewayTools({
      ...deps([p]),
      config: loadConfig({ env: {}, warn: () => {} }),
    });
    await tools.call('web_search', { query: 'q' });
    await tools.call('web_search', { query: 'q', count: 999 });
    await tools.call('web_search', { query: 'q', count: 0 });
    await tools.call('web_search', { query: 'q', count: '7' });
    expect(seen).toEqual([8, 50, 1, 7]);
  });

  it('treats a blank count as not provided, like a null one', async () => {
    // Number("") is 0, which used to clamp a blank to 1 while null fell back to
    // the configured count: two spellings of "unset" produced different searches.
    const seen: number[] = [];
    const p = fakeProvider('stepfun', async (req) => {
      seen.push(req.count);
      return { results: [], _meta: { provider: 'stepfun', total_latency_ms: 0, attempts: [] } };
    });
    const tools = createGatewayTools({
      ...deps([p]),
      config: loadConfig({ env: {}, warn: () => {} }),
    });
    await tools.call('web_search', { query: 'q', count: '' });
    await tools.call('web_search', { query: 'q', count: '   ' });
    await tools.call('web_search', { query: 'q', count: null });
    expect(seen).toEqual([8, 8, 8]);
  });

  it('coerces an unusable count but rejects an unusable enumeration', async () => {
    // Deliberate asymmetry, locked so it cannot drift silently:
    //  - count is a quantity with a declared range and a documented default, so
    //    any unusable value (null, "", {}, 999, true) degrades to that default.
    //  - strategy and providers are enumerations: there is no sensible fallback,
    //    and silently searching every channel when the caller named none would be
    //    worse than failing. null is not in either published JSON Schema, so it is
    //    a caller bug and is reported as one.
    const seen: any[] = [];
    const p = fakeProvider('stepfun', async (req) => {
      seen.push(req);
      return { results: [], _meta: { provider: 'stepfun', total_latency_ms: 0, attempts: [] } };
    });
    const tools = createGatewayTools({
      ...deps([p]),
      config: loadConfig({ env: {}, warn: () => {} }),
    });

    for (const count of [null, {}, true, 'abc', 0, 999]) {
      const out = await tools.call('web_search', { query: 'q', count });
      expect(out.isError, `count=${JSON.stringify(count)}`).toBeUndefined();
    }
    expect(seen.map((r) => r.count)).toEqual([8, 8, 8, 8, 1, 50]);

    for (const providers of [null, 'stepfun', 42]) {
      const out = await tools.call('web_search', { query: 'q', providers });
      expect(out.isError, `providers=${JSON.stringify(providers)}`).toBe(true);
      expect(parse(out).error).toContain("'providers' must be an array");
    }
    for (const strategy of [null, 42, ['fallback']]) {
      const out = await tools.call('web_search', { query: 'q', strategy });
      expect(out.isError, `strategy=${JSON.stringify(strategy)}`).toBe(true);
      expect(parse(out).error).toContain("'strategy' must be one of");
    }
  });
});

describe('web_search dispatch', () => {
  it('passes the configured strategy and settings through to the search function', async () => {
    let seen: any;
    const tools = createGatewayTools(
      deps([alive()], {
        searchFn: async (req, opts) => {
          seen = { req, opts };
          return { results: [], _meta: { provider: 'stepfun', total_latency_ms: 1, attempts: [] } };
        },
      }),
    );
    await tools.call('web_search', { query: 'hello' });
    expect(seen.req).toEqual({ query: 'hello', count: 8 });
    expect(seen.opts).toMatchObject({
      strategy: 'fallback', timeoutMs: 30_000, maxProviders: 4, dedupe: true,
    });
  });

  it('honours a per-call strategy and provider subset', async () => {
    let seen: any;
    const tools = createGatewayTools(
      deps([alive(), fakeProvider('kimi')], {
        searchFn: async (_req, opts) => {
          seen = opts;
          return { results: [], _meta: { provider: 'kimi', total_latency_ms: 1, attempts: [] } };
        },
      }),
    );
    await tools.call('web_search', { query: 'q', strategy: 'aggregate', providers: ['kimi'] });
    expect(seen.strategy).toBe('aggregate');
    expect(seen.providers.map((p: SearchProvider) => p.name)).toEqual(['kimi']);
  });

  it("forwards the caller's cancellation signal into the search options", async () => {
    let seen: unknown;
    const controller = new AbortController();
    const tools = createGatewayTools({
      ...deps([alive()]),
      searchFn: async (_req, opts) => {
        seen = opts.signal;
        return { results: [], _meta: { provider: 'stepfun', total_latency_ms: 0, attempts: [] } };
      },
    });
    await tools.call('web_search', { query: 'q' }, controller.signal);
    expect(seen).toBe(controller.signal);
  });

  it('passes no signal when the caller supplies none', async () => {
    let seen: unknown = 'unset';
    const tools = createGatewayTools({
      ...deps([alive()]),
      searchFn: async (_req, opts) => {
        seen = opts.signal;
        return { results: [], _meta: { provider: 'stepfun', total_latency_ms: 0, attempts: [] } };
      },
    });
    await tools.call('web_search', { query: 'q' });
    expect(seen).toBeUndefined();
  });

  it('returns the audit trail for a cancellation instead of logging it as unexpected', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const controller = new AbortController();
    controller.abort();
    const out = await createGatewayTools(deps([alive()])).call('web_search', { query: 'q' }, controller.signal);
    expect(out.isError).toBe(true);
    const body = parse(out);
    expect(body.error).toContain('cancelled');
    // The trail survives, so a caller can see what was in flight when it gave up.
    expect(body.attempts).toEqual([{ provider: 'stepfun', status: 'cancelled', latency_ms: 0 }]);
    // A normal lifecycle event is not an unexpected error.
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('redacts credential-looking text in unexpected errors', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tools = createGatewayTools({
      ...deps([alive()]),
      searchFn: async () => {
        throw new Error('upstream rejected key sk-EXAMPLEKEY01234567890');
      },
    });
    const out = await tools.call('web_search', { query: 'q' });
    expect(out.isError).toBe(true);
    // Same invariant as the audit trail: nothing key-shaped reaches a client.
    expect(out.content[0]!.text).not.toContain('EXAMPLEKEY01234567890');
    expect(out.content[0]!.text).toContain('sk-***');
    errSpy.mockRestore();
  });

  it('returns the orchestrator payload unchanged on success', async () => {
    const out = await createGatewayTools(deps([alive()])).call('web_search', { query: 'q' });
    expect(out.isError).toBeUndefined();
    const body = parse(out);
    expect(body._meta.provider).toBe('stepfun');
    expect(body.results).toHaveLength(1);
  });

  it('formats all-providers-failed as isError with the attempt trail', async () => {
    const failing = (name: string): SearchProvider => ({
      name,
      search: async () => {
        throw new HttpError(401, `HTTP 401: bad key (${name})`);
      },
    });
    const out = await createGatewayTools(deps([failing('a'), failing('b')])).call('web_search', { query: 'q' });
    expect(out.isError).toBe(true);
    const body = parse(out);
    expect(body.error).toContain('all configured providers failed');
    expect(body.attempts.map((a: AttemptRecord) => a.provider)).toEqual(['a', 'b']);
  });

  it('reports an empty chain as a structured business failure, not an unexpected crash', async () => {
    // NoProviderConfiguredError is the answer to "I called web_search before
    // configuring a key", not a bug. It must reach the client with its actionable
    // message and must not pollute stderr on every call.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await createGatewayTools(deps([])).call('web_search', { query: 'q' });
    expect(out.isError).toBe(true);
    expect(parse(out).error).toContain('no provider is configured');
    expect(parse(out).attempts).toEqual([]);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('logs and redacts a genuinely unexpected error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tools = createGatewayTools(
      deps([alive()], {
        searchFn: async () => {
          throw new TypeError('cannot read property of undefined');
        },
      }),
    );
    const out = await tools.call('web_search', { query: 'q' });
    expect(out.isError).toBe(true);
    expect(parse(out)).toEqual({
      error: 'TypeError: cannot read property of undefined',
      attempts: [],
    });
    expect(errSpy).toHaveBeenCalledOnce();
    errSpy.mockRestore();
  });

  it('stringifies non-Error unexpected failures', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tools = createGatewayTools(
      deps([alive()], {
        searchFn: async () => {
          // Deliberately throws a non-Error (cast to satisfy the throw rule)
          // to exercise the exact stringification the tool layer reports.
          throw 'plain string failure' as unknown as Error;
        },
      }),
    );
    const out = await tools.call('web_search', { query: 'q' });
    expect(parse(out)).toEqual({ error: 'plain string failure', attempts: [] });
    errSpy.mockRestore();
  });

  it('falls through a dead provider to the next one (real orchestrator)', async () => {
    const dead: SearchProvider = {
      name: 'dead',
      search: async () => {
        throw new AllProvidersFailedError([{ provider: 'dead', status: 'permanent_error', latency_ms: 1 }]);
      },
    };
    const out = await createGatewayTools(deps([dead, fakeProvider('alive')])).call('web_search', { query: 'q' });
    expect(out.isError).toBeUndefined();
    expect(parse(out)._meta.provider).toBe('alive');
  });
});

describe('unknown tools and textContent', () => {
  it('rejects unknown tools', async () => {
    const out = await createGatewayTools(deps([])).call('nope', {});
    expect(out.isError).toBe(true);
    expect(parse(out).error).toBe('unknown tool: nope');
  });

  it('marks errors only when asked', () => {
    expect(textContent({ a: 1 })).toEqual({ content: [{ type: 'text', text: '{\n  "a": 1\n}' }] });
    expect(textContent('x', true).isError).toBe(true);
  });
});
