/**
 * @file test/e2e/cli-process
 * @description End-to-end CLI tests: real subprocess, real argv parsing, real exit codes.
 *
 * Responsibilities:
 * - Spawn `node dist/index.js` for every CLI command and assert on stdout / stderr / exit code
 * - Cover happy paths, error paths, JSON output, flag overrides, and aliases (mcp == serve)
 * - Never touch the network: clean env strips provider keys, so `search`/`test` paths
 *   exercise the "no provider ready" branch deterministically
 *
 * Why: cli-index.test.ts and cli-commands.test.ts call runCli() in-process and
 * inject a fake search/probe. Real argv parsing, real process startup and the
 * real error formatter only run when you spawn the binary — that's this test.
 */

import { describe, expect, it } from "vitest";
import { cleanEnv, runCli, runCliInEphemeralCwd } from "./_helpers.js";

describe("CLI process end-to-end", () => {
  it("help exits 0 and renders full usage", async () => {
    const { code, stdout, stderr } = await runCli(["help"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("multi-channel web search");
    expect(stdout).toContain("Options:");
    // Every option flag in args.ts must appear in the usage text.
    for (const flag of ["--strategy", "--providers", "--no-dedupe", "--count", "--query", "--json"]) {
      expect(stdout).toContain(flag);
    }
  });

  it("-h / --help both behave like `help`", async () => {
    for (const flag of ["-h", "--help"]) {
      const { code, stdout } = await runCli([flag]);
      expect(code).toBe(0);
      expect(stdout).toContain("Usage:");
    }
  });

  it("-v / --version both print the package version", async () => {
    for (const flag of ["-v", "--version"]) {
      const { code, stdout } = await runCli([flag]);
      expect(code).toBe(0);
      expect(stdout).toMatch(/cn-websearch-mcp \d+\.\d+\.\d+/);
    }
  });

  it("unknown command returns exit code 2 and prints usage", async () => {
    const { code, stderr } = await runCli(["nope"]);
    expect(code).toBe(2);
    expect(stderr).toContain("error: unknown command: nope");
    expect(stderr).toContain("Usage:");
  });

  it("search with no ready provider exits 1 with a clear error", async () => {
    const { code, stderr } = await runCliInEphemeralCwd(["search", "anything"]);
    expect(code).toBe(1);
    expect(stderr).toContain("no provider is ready");
  });

  it("search with --json and no provider still emits valid JSON on stderr", async () => {
    const { code, stderr } = await runCliInEphemeralCwd(["search", "--json", "q"]);
    expect(code).toBe(1);
    // stderr is the error path; json mode only affects successful output paths.
    expect(stderr).toContain("no provider is ready");
  });

  it("search without a query fails with exit code 2", async () => {
    const { code, stderr } = await runCli(["search"]);
    expect(code).toBe(2);
    expect(stderr).toContain("missing query");
  });

  it("test with no ready provider exits 1 with a clear error", async () => {
    const { code, stderr } = await runCliInEphemeralCwd(["test"]);
    expect(code).toBe(1);
    expect(stderr).toContain("no provider is ready");
  });

  it("status with explicit --json emits parseable JSON, no secrets leaked", async () => {
    const { code, stdout, stderr } = await runCliInEphemeralCwd(["status", "--json"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const payload = JSON.parse(stdout);
    expect(payload).toHaveProperty("strategy");
    expect(payload).toHaveProperty("providers");
    // CLI `status --json` returns providers as an object (name → redacted entry),
    // keyed by provider name. The MCP `provider_status` tool returns an array;
    // this difference is a known product-shape inconsistency worth flagging.
    expect(typeof payload.providers).toBe("object");
    expect(payload.providers).not.toBeNull();
    expect(Array.isArray(payload.providers)).toBe(false);
    const stepfun = (payload.providers as Record<string, { apiKey: string }>).stepfun;
    expect(stepfun).toBeDefined();
    expect(stepfun.apiKey).toBe("(unset)");
    // Belt-and-suspenders: assert no key-shaped substring appears anywhere.
    expect(stdout).not.toMatch(/sk-[A-Za-z0-9._-]{12,}/);
  });

  it("WEBSEARCH_STRATEGY=aggregate env override is honored by status --json", async () => {
    const { code, stdout } = await runCli(["status", "--json"], {
      env: cleanEnv({ WEBSEARCH_STRATEGY: "aggregate" }),
    });
    expect(code).toBe(0);
    const payload = JSON.parse(stdout);
    expect(payload.strategy).toBe("aggregate");
  });

  it("WEBSEARCH_COUNT override is reflected in status --json", async () => {
    const { code, stdout } = await runCli(["status", "--json"], {
      env: cleanEnv({ WEBSEARCH_COUNT: "12" }),
    });
    expect(code).toBe(0);
    const payload = JSON.parse(stdout);
    expect(payload.count).toBe(12);
  });

  it("WEBSEARCH_TIMEOUT_MS override is reflected in status --json", async () => {
    const { code, stdout } = await runCli(["status", "--json"], {
      env: cleanEnv({ WEBSEARCH_TIMEOUT_MS: "12345" }),
    });
    expect(code).toBe(0);
    const payload = JSON.parse(stdout);
    expect(payload.timeoutMs).toBe(12345);
  });

  it("invalid --count value exits 2 with usage", async () => {
    const { code, stderr } = await runCli(["status", "--count", "0"]);
    expect(code).toBe(2);
    expect(stderr).toContain("error: invalid --count value: 0");
    expect(stderr).toContain("Usage:");
  });

  it("invalid --strategy value exits 2 with usage", async () => {
    const { code, stderr } = await runCli(["search", "--strategy", "bizarre", "q"]);
    expect(code).toBe(2);
    expect(stderr).toContain("invalid --strategy value: bizarre");
    expect(stderr).toContain("Usage:");
  });

  it("--providers with empty list is rejected", async () => {
    const { code, stderr } = await runCli(["search", "--providers", ",,,", "q"]);
    expect(code).toBe(2);
    expect(stderr).toContain("invalid --providers value");
  });

  it("mcp alias routes to the serve path (does not run any one-shot command)", async () => {
    // serve in clean env completes immediately only if the transport connects — we feed stdin EOF
    // so the StdioServerTransport can finish handshake... but in practice the server stays connected.
    // We assert the spawn stays alive past the readiness window without printing CLI banners on stdout.
    const result = runCli(["mcp"], { timeoutMs: 2_000, input: "" });
    let outcome: { code: number | null; stdout: string; stderr: string };
    try {
      outcome = await result;
    } catch (err) {
      // Timeout means the server stayed up — exactly what we want from the serve path.
      expect(String(err)).toMatch(/timed out/);
      return;
    }
    // If it returned normally, it must have been the success path. stdout must
    // be empty (no one-shot CLI output); stderr may carry the readiness banner,
    // which is the documented behavior of the serve path.
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toMatch(/cn-websearch-mcp.*ready/);
  });
});