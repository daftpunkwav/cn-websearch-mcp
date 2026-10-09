/**
 * @file test/cli-index
 * @description CLI dispatch tests: command routing, exit codes, serve failure
 * handling and usage output.
 */

import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { EXIT, runCli, type CliRunDeps } from '../src/cli/index.js';
import { createRuntime } from '../src/runtime.js';
import type { NormalizedSearchResult } from '../src/types.js';

const okResult = (provider: string): NormalizedSearchResult => ({
  results: [{ title: 'T', url: 'https://a.example', snippet: 's' }],
  _meta: { provider, total_latency_ms: 1, attempts: [] },
});

// Non-Error rejection fixture for the stringification path: the value is a
// primitive at runtime, typed Error only to satisfy the reject rule.
const PLAIN_FAILURE = 'plain' as unknown as Error;

function makeDeps(over: {
  serve?: () => Promise<void>;
  probe?: () => Promise<never>;
  env?: Record<string, string>;
} = {}): {
  deps: CliRunDeps;
  out: () => string;
  err: () => string;
} {
  const out: string[] = [];
  const err: string[] = [];
  const sink = (target: string[]): NodeJS.WritableStream => {
    const s = new PassThrough();
    s.on('data', (c) => target.push(c.toString()));
    return s;
  };
  const runtime = createRuntime({
    env: over.env ?? { STEPFUN_API_KEY: 's' },
    warn: () => {},
    configPath: undefined,
  });
  return {
    deps: {
      runtime,
      input: new PassThrough(),
      output: sink(out),
      error: sink(err),
      serve: over.serve ?? (async () => {}),
      search: async () => okResult('stepfun'),
      // Injected probe implementation: tests never make real network requests.
      probe:
        over.probe
        ?? ((providers) => Promise.resolve(providers.map((p) => ({
          provider: p.name, ok: true, latency_ms: 1, results: 1, sample: 'T', error: '',
        })))),
    },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

describe('runCli', () => {
  it('starts the MCP server by default (no arguments)', async () => {
    let served = 0;
    const { deps, out } = makeDeps({
      serve: async () => {
        served += 1;
      },
    });
    expect(await runCli([], deps)).toBe(EXIT.ok);
    expect(served).toBe(1);
    expect(out()).toBe('');
  });

  it('starts the MCP server for an explicit serve/mcp command', async () => {
    let served = 0;
    const { deps } = makeDeps({
      serve: async () => {
        served += 1;
      },
    });
    await runCli(['serve'], deps);
    await runCli(['mcp'], deps);
    expect(served).toBe(2);
  });

  it('returns failure when the server cannot start', async () => {
    const { deps, err } = makeDeps({
      serve: async () => {
        throw new Error('transport down');
      },
    });
    expect(await runCli(['serve'], deps)).toBe(EXIT.failure);
    expect(err()).toContain('fatal: transport down');
  });

  it('stringifies non-Error startup failures', async () => {
    const { deps, err } = makeDeps({
      // Deliberately rejects with a non-Error (cast to satisfy the reject
      // rule) to exercise the stringification path in the CLI.
      serve: () => Promise.reject(PLAIN_FAILURE),
    });
    expect(await runCli(['serve'], deps)).toBe(EXIT.failure);
    expect(err()).toContain('fatal: plain');
  });

  it('routes an unexpected command rejection through the same fatal boundary as serve', async () => {
    // cmdTest has no internal catch (expected probe failures already arrive as
    // rows), so a rejecting injected probe is the way a bug would reach the
    // dispatcher's fatal boundary instead of becoming an exit code.
    const { deps, err } = makeDeps({
      probe: () => Promise.reject(new Error('exploding probe')),
    });
    expect(await runCli(['test'], deps)).toBe(EXIT.failure);
    expect(err()).toContain('fatal: exploding probe');
  });

  it('routes search, status and test to their commands', async () => {
    const { deps, out } = makeDeps();
    expect(await runCli(['search', 'q'], deps)).toBe(EXIT.ok);
    expect(await runCli(['status'], deps)).toBe(EXIT.ok);
    expect(await runCli(['test'], deps)).toBe(EXIT.ok);
    expect(out()).toContain('answered by: stepfun');
    expect(out()).toContain('in-chain');
  });

  it('prints help and version without starting anything', async () => {
    const { deps, out } = makeDeps();
    expect(await runCli(['help'], deps)).toBe(EXIT.ok);
    expect(out()).toContain('Usage:');
    const versioned = makeDeps();
    expect(await runCli(['version'], versioned.deps)).toBe(EXIT.ok);
    expect(versioned.out()).toContain('cn-websearch-mcp');
    expect(versioned.out()).toMatch(/\d+\.\d+\.\d+/);
  });

  it('returns the usage exit code and prints help on a parse error', async () => {
    const { deps, err } = makeDeps();
    expect(await runCli(['--bogus'], deps)).toBe(EXIT.usage);
    expect(err()).toContain('error: unknown option: --bogus');
    expect(err()).toContain('Usage:');
  });

  it('runs the interactive session for the repl command', async () => {
    const { deps } = makeDeps();
    (deps.input as PassThrough).end('/quit\n');
    expect(await runCli(['repl'], deps)).toBe(EXIT.ok);
  });
});
