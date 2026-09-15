/**
 * @file test/cli-repl
 * @description Interactive session tests: readline driven by injected streams, covering queries, slash commands and fault tolerance.
 */

import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { runRepl } from "../src/cli/repl.js";
import { createRuntime } from "../src/runtime.js";
import type { CliDeps } from "../src/cli/commands.js";
import type { NormalizedSearchResult, SearchProvider } from "../src/types.js";

const okResult = (provider: string): NormalizedSearchResult => ({
  results: [{ title: `${provider} title`, url: `https://${provider}.example`, snippet: "s" }],
  _meta: { provider, total_latency_ms: 1, attempts: [] },
});

/** Drives one session with scripted input and returns all output text. */
async function session(
  lines: string[],
  over: { env?: Record<string, string>; search?: CliDeps["search"]; probe?: CliDeps["probe"] } = {},
): Promise<{ text: string; code: number }> {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (c) => chunks.push(c.toString()));
  const runtime = createRuntime({
    env: over.env ?? { STEPFUN_API_KEY: "s", KIMI_API_KEY: "k" },
    warn: () => {},
    configPath: undefined,
  });
  const deps: CliDeps = {
    runtime,
    input,
    output,
    error: output,
    search: over.search ?? (async () => okResult("stepfun")),
    probe:
      over.probe ??
      (async (providers: SearchProvider[]) =>
        providers.map((p) => ({ provider: p.name, ok: true, latency_ms: 1, results: 1, sample: "T", error: "" }))),
  };
  const running = runRepl(deps, { input });
  for (const line of lines) input.write(line + "\n");
  input.end();
  const code = await running;
  return { text: chunks.join(""), code };
}

describe("runRepl", () => {
  it("greets with the ready providers and exits cleanly on /quit", async () => {
    const { text, code } = await session(["/quit"]);
    expect(text).toContain("interactive session");
    expect(text).toContain("2 provider(s) ready");
    expect(code).toBe(0);
  });

  it("treats bare text as a search", async () => {
    const seen: string[] = [];
    const { text } = await session(["hello world", "/quit"], {
      search: async (req) => {
        seen.push(req.query);
        return okResult("stepfun");
      },
    });
    expect(seen).toEqual(["hello world"]);
    expect(text).toContain("answered by: stepfun");
  });

  it("supports /search and one-off /aggregate", async () => {
    const strategies: string[] = [];
    const { text } = await session(["/search explicit", "/aggregate multi source", "/quit"], {
      search: async (_req, opts) => {
        strategies.push(opts.strategy);
        return okResult("kimi");
      },
    });
    expect(strategies).toEqual(["fallback", "aggregate"]);
    expect(text).toContain("answered by: kimi");
  });

  it("reports usage instead of searching on an empty /search", async () => {
    const { text } = await session(["/search", "/quit"]);
    expect(text).toContain("usage: /search <query>");
  });

  it("refuses a flag-looking query and points at the slash commands", async () => {
    const searches: string[] = [];
    const { text } = await session(["/search --json foo", "/aggregate --json bar", "--bare", "/quit"], {
      search: async (req) => {
        searches.push(req.query);
        return okResult("kimi");
      },
    });
    // Neither searches with --json as a query term nor treats it as a switch.
    expect(searches).toEqual([]);
    expect(text).toContain("/search takes a query only");
    expect(text).toContain("/aggregate takes a query only");
    expect(text).toContain("error: /search takes a query only — use /json, /count, /strategy or /providers to change session settings");
  });

  it("shows and updates the session strategy", async () => {
    const strategies: string[] = [];
    const { text } = await session(["/strategy", "/strategy aggregate", "/status", "/quit"], {
      search: async (_req, opts) => {
        strategies.push(opts.strategy);
        return okResult("kimi");
      },
    });
    expect(text).toContain("strategy: fallback");
    expect(text).toContain("strategy: aggregate");
    expect(text).toContain("in-chain");
    expect(strategies).toEqual([]);
  });

  it("rejects an unknown strategy or count without ending the session", async () => {
    const { text } = await session(["/strategy turbo", "/count abc", "/count 0", "/quit"]);
    expect(text).toContain('error: unknown strategy "turbo"');
    expect(text).toContain('error: invalid count "abc"');
    expect(text).toContain('error: invalid count "0"');
  });

  it("shows and updates count and providers", async () => {
    const counts: number[] = [];
    const { text } = await session(
      ["/count", "/count 3", "/providers", "/providers kimi,zhipu", "/providers all", "/quit"],
      {
        search: async (req) => {
          counts.push(req.count);
          return okResult("kimi");
        },
      },
    );
    expect(text).toContain("count: 8");
    expect(text).toContain("count: 3");
    expect(text).toContain("providers: (all available)");
    expect(text).toContain("providers: kimi, zhipu");
    expect(counts).toEqual([]);
  });

  it("rejects unknown providers listed for the session", async () => {
    const { text } = await session(["/providers openai", "/quit"]);
    expect(text).toContain("error: unknown provider(s): openai");
  });

  it("probes providers via /test, optionally for one provider", async () => {
    const probed: string[][] = [];
    const { text } = await session(["/test", "/test kimi", "/quit"], {
      probe: async (providers) => {
        probed.push(providers.map((p) => p.name));
        return providers.map((p) => ({ provider: p.name, ok: true, latency_ms: 1, results: 1, sample: "T", error: "" }));
      },
    });
    expect(probed[0]).toEqual(["kimi", "stepfun"]);
    expect(probed[1]).toEqual(["kimi"]);
    expect(text).toContain("provider   status");
  });

  it("prints the redacted configuration via /config without leaking keys", async () => {
    const { text } = await session(["/config", "/quit"], { env: { STEPFUN_API_KEY: "leak-me-please" } });
    expect(text).not.toContain("leak-me-please");
    expect(text).toContain('"apiKey": "(set)"');
  });

  it("toggles raw JSON output and reflects it in status output", async () => {
    const { text } = await session(["/json", "/json on", "/status", "/json off", "/json maybe", "/quit"]);
    expect(text).toContain("json: off");
    expect(text).toContain("json: on");
    expect(text).toContain('"strategy"');
    expect(text).toContain("error: expected /json on or /json off");
  });

  it("prints help for /help and hints on unknown commands", async () => {
    const { text } = await session(["/help", "/nope", "/quit"]);
    expect(text).toContain("/aggregate <query>");
    expect(text).toContain("unknown command: /nope");
  });

  it("keeps the session alive when a search throws", async () => {
    const { text, code } = await session(["boom", "/quit"], {
      search: async () => {
        throw new Error("kaboom");
      },
    });
    expect(text).toContain("kaboom");
    expect(code).toBe(0);
  });

  it("ignores blank input and accepts /exit and /q", async () => {
    const { code } = await session(["", "   ", "/exit"]);
    expect(code).toBe(0);
    expect((await session(["/q"])).code).toBe(0);
  });

  it("ends the session on input close (Ctrl-D)", async () => {
    const { code } = await session([]);
    expect(code).toBe(0);
  });
});
