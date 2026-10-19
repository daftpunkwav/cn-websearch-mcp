/**
 * @file test/runtime
 * @description Runtime assembly unit tests: config file loading, enabled/key
 * filtering and warning degradation.
 */

import {
  describe, expect, it, vi,
} from 'vitest';
import { createRuntime } from '../src/runtime.js';

const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => over;

describe('createRuntime', () => {
  // `configPath: undefined` means "look for the conventional file", which without
  // an explicit fileExists check reaches into the developer's own working
  // directory: a cn-websearch.config.json there (gitignored, so CI never has one)
  // silently changes what these tests assert. fileExists: () => false is what
  // "no config file" actually means here, as in test/probe.test.ts.
  const noConfigFile = { configPath: undefined, fileExists: () => false } as const;

  it('builds providers in configured order and keeps only enabled+keyed ones in the chain', () => {
    const runtime = createRuntime({
      env: env({
        KIMI_API_KEY: 'k',
        STEPFUN_API_KEY: 's',
        ZHIPU_API_KEY: 'z',
        MIMO_API_KEY: 'm',
        WEBSEARCH_ORDER: 'zhipu,mimo,kimi,stepfun',
        ZHIPU_ENABLED: 'false',
      }),
      warn: () => {},
      ...noConfigFile,
    });
    expect(runtime.providers.map((p) => p.name)).toEqual(['zhipu', 'mimo', 'kimi', 'stepfun']);
    // zhipu has a key but is explicitly disabled; mimo/kimi/stepfun participate in search.
    expect(runtime.chain.map((p) => p.name)).toEqual(['mimo', 'kimi', 'stepfun']);
  });

  it('excludes providers without a key', () => {
    const runtime = createRuntime({ env: env({ STEPFUN_API_KEY: 's' }), warn: () => {}, ...noConfigFile });
    expect(runtime.chain.map((p) => p.name)).toEqual(['stepfun']);
  });

  it('treats an explicit order as the participation filter, not only as a ranking', () => {
    // Documented in README: a slot left out of order / WEBSEARCH_ORDER is never
    // searched even when it is enabled and keyed. This is why provider-selection
    // cannot answer "why is this unavailable?" with the key or the switch alone.
    const runtime = createRuntime({
      env: env({ KIMI_API_KEY: 'k', STEPFUN_API_KEY: 's', WEBSEARCH_ORDER: 'stepfun' }),
      warn: () => {},
      ...noConfigFile,
    });
    expect(runtime.config.providers.kimi.enabled).toBe(true);
    expect(runtime.config.providers.kimi.apiKey).not.toBe('');
    expect(runtime.chain.map((p) => p.name)).toEqual(['stepfun']);
  });

  it('produces an empty chain when no key is configured at all', () => {
    const runtime = createRuntime({ env: env(), warn: () => {}, ...noConfigFile });
    expect(runtime.chain).toEqual([]);
    expect(runtime.providers).toHaveLength(4);
  });

  it('loads and applies a config file (priority, strategy, per-provider settings)', () => {
    const runtime = createRuntime({
      env: env({ STEPFUN_API_KEY: 's', KIMI_API_KEY: 'k' }),
      warn: () => {},
      configPath: '/cfg.json',
      readFile: () => JSON.stringify({
        strategy: 'aggregate',
        order: ['stepfun', 'kimi'],
        providers: { kimi: { enabled: false, options: { maxRounds: 3 } } },
      }),
    });
    expect(runtime.config.strategy).toBe('aggregate');
    expect(runtime.config.order).toEqual(['stepfun', 'kimi']);
    expect(runtime.config.configFile).toBe('/cfg.json');
    expect(runtime.config.providers.kimi.options).toEqual({ maxRounds: 3 });
    expect(runtime.chain.map((p) => p.name)).toEqual(['stepfun']);
  });

  it('keeps running with defaults when the config file is broken', () => {
    const warnings: string[] = [];
    const runtime = createRuntime({
      env: env({ STEPFUN_API_KEY: 's' }),
      warn: (m) => warnings.push(m),
      configPath: '/broken.json',
      readFile: () => '{not json',
    });
    expect(warnings.some((w) => w.includes('not valid JSON'))).toBe(true);
    expect(runtime.config.strategy).toBe('fallback');
    expect(runtime.chain.map((p) => p.name)).toEqual(['stepfun']);
  });

  it('reports config problems on stderr when no warn callback is given', () => {
    // The default sink keeps a broken configuration visible instead of silent.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createRuntime({ env: env({ WEBSEARCH_TIMEOUT_MS: 'abc' }), ...noConfigFile });
    expect(errSpy).toHaveBeenCalledOnce();
    expect(String(errSpy.mock.calls[0]![0])).toContain('WEBSEARCH_TIMEOUT_MS');
    errSpy.mockRestore();
  });

  it('discovers the conventional config file when present', () => {
    const runtime = createRuntime({
      env: env(),
      warn: () => {},
      cwd: '/work',
      fileExists: (p) => p.includes('cn-websearch.config.json'),
      readFile: () => JSON.stringify({ count: 4 }),
    });
    expect(runtime.config.count).toBe(4);
    expect(runtime.config.configFile).toContain('cn-websearch.config.json');
  });
});
