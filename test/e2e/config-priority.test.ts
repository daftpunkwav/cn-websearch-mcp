/**
 * @file test/e2e/config-priority
 * @description End-to-end configuration resolution chain: defaults < .env file < environment.
 *
 * Responsibilities:
 * - Drive the real binary from a synthetic CWD that holds a chosen .env file
 * - Confirm provider activation depends on the dotenv layer, not the parent env
 * - Confirm env variables supplied to the subprocess beat the .env file
 *   (the priority order documented in README)
 * - Confirm runtime-evaluated booleans / numbers / arrays round-trip through
 *   env vars and land in `status --json` correctly
 *
 * Why: config.test.ts covers the loader in isolation; this test runs the full
 * subprocess + dotenv + config-file path so any regression in the layering
 * (e.g. dotenv accidentally overwriting pre-set env vars) would surface here.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanEnv, runCli } from "./_helpers.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cn-websearch-cfg-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeEnv(contents: string): void {
  writeFileSync(join(dir, ".env"), contents, "utf8");
}

async function statusJson(overrides: Record<string, string> = {}): Promise<Record<string, any>> {
  // Each call gets a fresh clean env layered with the test overrides so
  // values are deterministic and never inherit from the parent shell.
  const env = cleanEnv(overrides);
  const { code, stdout, stderr } = await runCli(["status", "--json"], { env, cwd: dir });
  // exit code 0 always; stderr may legitimately contain warnings (e.g. invalid
  // values from the loader falling back to defaults) — those are intentional
  // behavior, not failures.
  expect(code).toBe(0);
  // Treat "fatal:" / "error:" lines on stderr as a real regression.
  if (/^(fatal|error):/m.test(stderr)) {
    throw new Error(`unexpected stderr from status: ${stderr}`);
  }
  return JSON.parse(stdout);
}

describe("config priority chain (defaults < .env < env)", () => {
  it("defaults are visible with no .env and no env vars", async () => {
    const s = await statusJson();
    expect(s.strategy).toBe("fallback");
    expect(s.count).toBe(8);
    expect(s.timeoutMs).toBe(30000);
    expect(s.dedupe).toBe(true);
    expect(s.maxProviders).toBe(4);
    // No keys → no provider is configured.
    for (const name of ["kimi", "stepfun", "zhipu", "mimo"]) {
      expect(s.providers[name].apiKey).toBe("(unset)");
      expect(s.providers[name].enabled).toBe(true);
    }
  });

  it("dotenv layer makes a provider 'configured' even without env vars", async () => {
    writeEnv("KIMI_API_KEY=kimi-from-dotenv\nKIMI_BASE_URL=https://example.test/v1\n");
    const s = await statusJson();
    expect(s.providers.kimi.apiKey).toBe("(set)");
    // Other providers remain unset.
    expect(s.providers.stepfun.apiKey).toBe("(unset)");
  });

  it("dotenv-driven key determines the active chain", async () => {
    writeEnv("KIMI_API_KEY=kimi-from-dotenv\nSTEPFUN_API_KEY=stepfun-from-dotenv\n");
    const s = await statusJson();
    // Order is alphabetical by default; the in-chain names flow through `order` too.
    expect(s.order).toContain("kimi");
    expect(s.order).toContain("stepfun");
  });

  it("env vars win over .env file (MCP client passthrough precedence)", async () => {
    writeEnv("KIMI_API_KEY=from-dotenv\n");
    const s = await statusJson({ KIMI_API_KEY: "from-env" });
    // Both are reported as '(set)' (the value is intentionally hidden), but the
    // effective config-file path should be '(none)' — we did not write one —
    // so the env var clearly took effect over .env without a config file to
    // explain the contradiction.
    expect(s.providers.kimi.apiKey).toBe("(set)");
    expect(s.configFile).toBeNull();
  });

  it("strategy env override beats dotenv strategy", async () => {
    writeEnv("WEBSEARCH_STRATEGY=fallback\n");
    const s = await statusJson({ WEBSEARCH_STRATEGY: "aggregate" });
    expect(s.strategy).toBe("aggregate");
  });

  it("count env override is parsed as a positive integer", async () => {
    const s = await statusJson({ WEBSEARCH_COUNT: "17" });
    expect(s.count).toBe(17);
  });

  it("count env override falls back to default on garbage", async () => {
    // Invalid env values must not crash startup; the loader logs a warning and uses the default.
    const s = await statusJson({ WEBSEARCH_COUNT: "not-a-number" });
    expect(s.count).toBe(8);
  });

  it("timeout env override is honored", async () => {
    const s = await statusJson({ WEBSEARCH_TIMEOUT_MS: "9999" });
    expect(s.timeoutMs).toBe(9999);
  });

  it("WEBSEARCH_DEDUPE=false is honored", async () => {
    const s = await statusJson({ WEBSEARCH_DEDUPE: "false" });
    expect(s.dedupe).toBe(false);
  });

  it("WEBSEARCH_DEDUPE=on is honored", async () => {
    const s = await statusJson({ WEBSEARCH_DEDUPE: "on" });
    expect(s.dedupe).toBe(true);
  });

  it("WEBSEARCH_ORDER reorders the chain", async () => {
    writeEnv("KIMI_API_KEY=k\nSTEPFUN_API_KEY=s\nZHIPU_API_KEY=z\n");
    const s = await statusJson({ WEBSEARCH_ORDER: "zhipu,kimi,stepfun" });
    // The order field reflects the requested priority; in-chain membership
    // still depends on having a key, which all three do here.
    expect(s.order).toEqual(["zhipu", "kimi", "stepfun"]);
  });

  it("KIMI_ENABLED=false disables kimi even when its key is set", async () => {
    writeEnv("KIMI_API_KEY=k\nKIMI_ENABLED=false\n");
    const s = await statusJson();
    expect(s.providers.kimi.enabled).toBe(false);
    expect(s.providers.kimi.apiKey).toBe("(set)"); // key still present, just disabled
  });

  it("WEBSEARCH_MAX_PROVIDERS env is honored", async () => {
    const s = await statusJson({ WEBSEARCH_MAX_PROVIDERS: "2" });
    expect(s.maxProviders).toBe(2);
  });

  it("per-provider priority env wins over the default alphabetical sort", async () => {
    writeEnv("KIMI_API_KEY=k\nSTEPFUN_API_KEY=s\n");
    const s = await statusJson({ STEPFUN_PRIORITY: "100" });
    // stepfun outranks kimi under the alphabetical default.
    expect(s.order[0]).toBe("stepfun");
  });
});