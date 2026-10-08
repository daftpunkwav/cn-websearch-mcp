/**
 * @file test/cli-repl
 * @description Interactive session tests: readline driven by injected streams,
 * covering queries, slash commands and fault tolerance.
 */

import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { runRepl } from '../src/cli/repl.js';
import { createRuntime } from '../src/runtime.js';
import { DEFAULT_PROBE_QUERY, type CliDeps } from '../src/cli/commands.js';
import type { NormalizedSearchResult, SearchProvider } from '../src/types.js';

const okResult = (provider: string): NormalizedSearchResult => ({
  results: [{ title: `${provider} title`, url: `https://${provider}.example`, snippet: 's' }],
  _meta: { provider, total_latency_ms: 1, attempts: [] },
});

/** Drives one session with scripted input and returns all output text. */
async function session(
  lines: string[],
  over: { env?: Record<string, string>; search?: CliDeps['search']; probe?: CliDeps['probe'] } = {},
): Promise<{ text: string; code: number }> {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on('data', (c) => chunks.push(c.toString()));
  const runtime = createRuntime({
    env: over.env ?? { STEPFUN_API_KEY: 's', KIMI_API_KEY: 'k' },
    warn: () => {},
    configPath: undefined,
  });
  const deps: CliDeps = {
    runtime,
    output,
    error: output,
    search: over.search ?? (async () => okResult('stepfun')),
    probe:
      over.probe
      ?? ((providers: SearchProvider[]) => Promise.resolve(providers.map((p) => ({
        provider: p.name, ok: true, latency_ms: 1, results: 1, sample: 'T', error: '',
      })))),
  };
  const running = runRepl(deps, { input });
  for (const line of lines) input.write(`${line}\n`);
  input.end();
  const code = await running;
  return { text: chunks.join(''), code };
}

describe('runRepl', () => {
  it('greets with the ready providers and exits cleanly on /quit', async () => {
    const { text, code } = await session(['/quit']);
    expect(text).toContain('interactive session');
    expect(text).toContain('2 provider(s) ready');
    expect(code).toBe(0);
  });

  it('treats bare text as a search', async () => {
    const seen: string[] = [];
    const { text } = await session(['hello world', '/quit'], {
      search: async (req) => {
        seen.push(req.query);
        return okResult('stepfun');
      },
    });
    expect(seen).toEqual(['hello world']);
    expect(text).toContain('answered by: stepfun');
  });

  it('supports /search and one-off /aggregate', async () => {
    const strategies: string[] = [];
    const { text } = await session(['/search explicit', '/aggregate multi source', '/quit'], {
      search: async (_req, opts) => {
        strategies.push(opts.strategy);
        return okResult('kimi');
      },
    });
    expect(strategies).toEqual(['fallback', 'aggregate']);
    expect(text).toContain('answered by: kimi');
  });

  it('reports usage instead of searching on an empty /search', async () => {
    const { text } = await session(['/search', '/quit']);
    expect(text).toContain('usage: /search <query>');
  });

  it('refuses a flag-looking query and points at the slash commands', async () => {
    const searches: string[] = [];
    const { text } = await session(['/search --json foo', '/aggregate --json bar', '--bare', '/quit'], {
      search: async (req) => {
        searches.push(req.query);
        return okResult('kimi');
      },
    });
    // Neither searches with --json as a query term nor treats it as a switch.
    expect(searches).toEqual([]);
    expect(text).toContain('/search takes a query only');
    expect(text).toContain('/aggregate takes a query only');
    expect(text).toContain('error: /search takes a query only — use /json, /count, /strategy or /providers to change session settings');
  });

  it('shows and updates the session strategy', async () => {
    const strategies: string[] = [];
    const { text } = await session(['/strategy', '/strategy aggregate', '/status', '/quit'], {
      search: async (_req, opts) => {
        strategies.push(opts.strategy);
        return okResult('kimi');
      },
    });
    expect(text).toContain('strategy: fallback');
    expect(text).toContain('strategy: aggregate');
    expect(text).toContain('in-chain');
    expect(strategies).toEqual([]);
  });

  it('rejects an unknown strategy or count without ending the session', async () => {
    const { text } = await session(['/strategy turbo', '/count abc', '/count 0', '/quit']);
    expect(text).toContain('error: unknown strategy "turbo"');
    expect(text).toContain('error: invalid count "abc"');
    expect(text).toContain('error: invalid count "0"');
  });

  it('clamps an out-of-range count to the range searches actually use', async () => {
    const counts: number[] = [];
    const { text } = await session(['/count 999', 'hello', '/quit'], {
      search: async (req) => {
        counts.push(req.count);
        return okResult('kimi');
      },
    });
    // Echoing 999 while the search silently used 50 left the session display and
    // the effective behaviour disagreeing.
    expect(text).toContain('count: 50');
    expect(text).not.toContain('count: 999');
    expect(counts).toEqual([50]);
  });

  it('shows and updates count and providers', async () => {
    const counts: number[] = [];
    const { text } = await session(
      ['/count', '/count 3', '/providers', '/providers kimi,zhipu', '/providers all', '/quit'],
      {
        search: async (req) => {
          counts.push(req.count);
          return okResult('kimi');
        },
      },
    );
    expect(text).toContain('count: 8');
    expect(text).toContain('count: 3');
    expect(text).toContain('providers: (all available)');
    expect(text).toContain('providers: kimi, zhipu');
    expect(counts).toEqual([]);
  });

  it('rejects unknown providers listed for the session', async () => {
    const { text } = await session(['/providers openai', '/quit']);
    expect(text).toContain('error: unknown provider(s): openai');
  });

  it('probes providers via /test, optionally for one provider', async () => {
    const probed: string[][] = [];
    const queries: string[] = [];
    const { text } = await session(['/test', '/test kimi', '/test stepfun kimi', '/quit'], {
      probe: (providers, req) => {
        probed.push(providers.map((p) => p.name));
        queries.push(req.query);
        return Promise.resolve(providers.map((p) => ({
          provider: p.name, ok: true, latency_ms: 1, results: 1, sample: 'T', error: '',
        })));
      },
    });
    expect(probed[0]).toEqual(['kimi', 'stepfun']);
    expect(probed[1]).toEqual(['kimi']);
    expect(probed[2]).toEqual(['stepfun', 'kimi']);
    // Positional words are provider names only: a health check must never search
    // for the slot name it was asked to probe.
    expect(queries).toEqual([DEFAULT_PROBE_QUERY, DEFAULT_PROBE_QUERY, DEFAULT_PROBE_QUERY]);
    expect(text).toContain('provider   status');
  });

  it('prints the redacted configuration via /config without leaking keys', async () => {
    const { text } = await session(['/config', '/quit'], { env: { STEPFUN_API_KEY: 'leak-me-please' } });
    expect(text).not.toContain('leak-me-please');
    expect(text).toContain('"apiKey": "(set)"');
  });

  it('toggles raw JSON output and reflects it in status output', async () => {
    const { text } = await session(['/json', '/json on', '/status', '/json off', '/json maybe', '/quit']);
    expect(text).toContain('json: off');
    expect(text).toContain('json: on');
    expect(text).toContain('"strategy"');
    expect(text).toContain('error: expected /json on or /json off');
  });

  it('prints help for /help and hints on unknown commands', async () => {
    const { text } = await session(['/help', '/nope', '/quit']);
    expect(text).toContain('/aggregate <query>');
    expect(text).toContain('unknown command: /nope');
  });

  it('keeps the session alive when a search throws', async () => {
    const { text, code } = await session(['boom', '/quit'], {
      search: async () => {
        throw new Error('kaboom');
      },
    });
    expect(text).toContain('kaboom');
    expect(code).toBe(0);
  });

  it('ignores blank input and accepts /exit and /q', async () => {
    const { code } = await session(['', '   ', '/exit']);
    expect(code).toBe(0);
    expect((await session(['/q'])).code).toBe(0);
  });

  it('ends the session on input close (Ctrl-D)', async () => {
    const { code } = await session([]);
    expect(code).toBe(0);
  });
});

/**
 * Fault tolerance around the per-command handler.
 *
 * Everything here drives the session through a stream that is marked as a TTY,
 * because that is what readline keys its interrupt handling off: a plain pipe
 * delivers `\u0003` as ordinary text and never raises SIGINT, so a test written
 * against a bare PassThrough would pass without the interrupt path running at
 * all (verified: the session hangs instead of exiting).
 */
describe('runRepl fault tolerance', () => {
  /** Same as session(), but with a TTY-marked output and a controllable input. */
  function ttySession(
    write: (input: PassThrough) => void,
    over: { search?: CliDeps['search']; probe?: CliDeps['probe'] } = {},
  ): { done: Promise<{ text: string; code: number }> } {
    const input = new PassThrough();
    const output = new PassThrough() as PassThrough & { isTTY?: boolean };
    output.isTTY = true;
    const chunks: string[] = [];
    output.on('data', (c) => chunks.push(c.toString()));
    const runtime = createRuntime({
      env: { STEPFUN_API_KEY: 's' },
      warn: () => {},
      configPath: undefined,
    });
    const deps: CliDeps = {
      runtime,
      output,
      error: output,
      search: over.search ?? (async () => okResult('stepfun')),
      probe:
        over.probe
        ?? ((providers: SearchProvider[]) => Promise.resolve(providers.map((p) => ({
          provider: p.name, ok: true, latency_ms: 1, results: 1, sample: 'T', error: '',
        })))),
    };
    const running = runRepl(deps, { input });
    write(input);
    return { done: running.then((code) => ({ text: chunks.join(''), code })) };
  }

  /** Fails the test rather than hanging if the session never settles. */
  const settle = <T>(p: Promise<T>): Promise<T> => Promise.race([
    p,
    new Promise<T>((_, rej) => {
      setTimeout(() => rej(new Error('session never exited')), 3_000);
    }),
  ]);

  it('reports a command that throws and keeps the session usable', async () => {
    // `/test` awaits the probe with no try/catch of its own, so a throwing
    // probe is what actually reaches the REPL's per-command handler; a
    // throwing search is absorbed by cmdSearch and never gets there.
    const { done } = ttySession(
      (input) => {
        input.write('/test\n/quit\n');
        input.end();
      },
      {
        probe: async () => {
          throw new Error('probe exploded while holding ak-EXAMPLEKEY01234567890');
        },
      },
    );
    const { text, code } = await settle(done);
    // The credential-shaped fragment must not reach the terminal: the handler
    // summarizes through the same redaction the audit trail uses.
    expect(text).toContain('probe exploded');
    expect(text).not.toContain('EXAMPLEKEY01234567890');
    expect(text).toContain('ak-***');
    // The session survived the failure and still exited normally.
    expect(code).toBe(0);
  });

  it('exits 0 on Ctrl-C without a closed-interface write', async () => {
    // The prompt is written after each handled line. Once SIGINT closes the
    // interface, a queued continuation that prompts anyway would throw
    // ERR_USE_AFTER_CLOSE out of the promise chain instead of resolving.
    const uncaught: string[] = [];
    const onUncaught = (err: Error): void => {
      uncaught.push(`${err.name}: ${err.message}`);
    };
    process.on('uncaughtException', onUncaught);
    try {
      let release: (() => void) | undefined;
      const { done } = ttySession(
        (input) => {
          input.write('a slow query\n');
          // Let the search start, then interrupt while it is still in flight so
          // the queued continuation runs after the interface is already closed.
          setTimeout(() => input.write('\u0003'), 30);
          setTimeout(() => release?.(), 60);
        },
        {
          search: async () => {
            await new Promise<void>((r) => {
              release = r;
            });
            return okResult('stepfun');
          },
        },
      );
      const { code } = await settle(done);
      expect(code).toBe(0);
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });
});
