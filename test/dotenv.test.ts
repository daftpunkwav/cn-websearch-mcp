/**
 * @file test/dotenv
 * @description .env loader unit tests: key/value parsing, quote stripping, never overwriting existing variables, and refusing names the gateway does not read.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGatewayEnvKey, loadDotEnv } from "../src/dotenv.js";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "cwsmcp-env-"));
}

/** Write a .env into a fresh temp dir, load it, and clean up. */
function load(contents: string): { env: Record<string, string>; warnings: string[] } {
  const dir = makeDir();
  try {
    writeFileSync(join(dir, ".env"), contents);
    const env: Record<string, string> = {};
    const warnings: string[] = [];
    loadDotEnv(dir, env as NodeJS.ProcessEnv, (m) => warnings.push(m));
    return { env, warnings };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadDotEnv", () => {
  it("loads KEY=VALUE pairs and strips quotes", () => {
    const { env } = load('KIMI_API_KEY=1\nMIMO_MODEL="two words"\nSTEPFUN_BASE_URL=\'three\'\n\n# comment\n=KIMI_API_KEY\nKIMI_PRIORITY');
    expect(env).toEqual({ KIMI_API_KEY: "1", MIMO_MODEL: "two words", STEPFUN_BASE_URL: "three" });
  });

  it("strips a leading UTF-8 BOM so the first key is not silently corrupted", () => {
    // Windows editors commonly save .env as UTF-8 with BOM; without stripping it the
    // first key would carry an invisible prefix and never match env lookups.
    const { env } = load("\uFEFFKIMI_API_KEY=secret\nMIMO_MODEL=2");
    expect(env).toEqual({ KIMI_API_KEY: "secret", MIMO_MODEL: "2" });
  });

  it("never overwrites existing entries", () => {
    const dir = makeDir();
    try {
      writeFileSync(join(dir, ".env"), "KIMI_API_KEY=from-file");
      const env = { KIMI_API_KEY: "from-process" } as unknown as NodeJS.ProcessEnv;
      loadDotEnv(dir, env);
      expect(env.KIMI_API_KEY).toBe("from-process");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op when the file is missing or the dir does not exist", () => {
    const env: Record<string, string> = {};
    loadDotEnv(join(tmpdir(), "no-such-dir-xyz"), env as NodeJS.ProcessEnv);
    expect(env).toEqual({});
  });

  it("reads only the first = as separator and keeps later ones in the value", () => {
    const { env } = load("WEBSEARCH_CONFIG=https://x.example/a=b");
    expect(env.WEBSEARCH_CONFIG).toBe("https://x.example/a=b");
  });

  it("writes keys colliding with Object.prototype members (Object.hasOwn check)", () => {
    const dir = makeDir();
    try {
      writeFileSync(join(dir, ".env"), "KIMI_API_KEY=from-file");
      // `key in env` would find the prototype-chain entry and skip the line,
      // so the check must be own-property only.
      const env = Object.create({ KIMI_API_KEY: "from-prototype" }) as Record<string, string>;
      loadDotEnv(dir, env as NodeJS.ProcessEnv);
      expect(Object.hasOwn(env, "KIMI_API_KEY")).toBe(true);
      expect(env.KIMI_API_KEY).toBe("from-file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads every gateway variable the config layer reads", () => {
    const { env } = load(
      [
        "KIMI_API_KEY=k",
        "MIMO_BASE_URL=https://mimo.example",
        "STEPFUN_MODEL=step-model",
        "ZHIPU_ENABLED=false",
        "KIMI_PRIORITY=3",
        "MIMO_TIMEOUT_MS=1234",
        "ZHIPU_SEARCH_ENGINE=search_pro",
        "WEBSEARCH_ORDER=zhipu,kimi",
        "WEBSEARCH_STRATEGY=aggregate",
        "WEBSEARCH_TIMEOUT_MS=999",
        "WEBSEARCH_COUNT=3",
        "WEBSEARCH_MAX_PROVIDERS=2",
        "WEBSEARCH_DEDUPE=false",
        "WEBSEARCH_CONFIG=./cfg.json",
      ].join("\n"),
    );
    expect(env).toEqual({
      KIMI_API_KEY: "k",
      MIMO_BASE_URL: "https://mimo.example",
      STEPFUN_MODEL: "step-model",
      ZHIPU_ENABLED: "false",
      KIMI_PRIORITY: "3",
      MIMO_TIMEOUT_MS: "1234",
      ZHIPU_SEARCH_ENGINE: "search_pro",
      WEBSEARCH_ORDER: "zhipu,kimi",
      WEBSEARCH_STRATEGY: "aggregate",
      WEBSEARCH_TIMEOUT_MS: "999",
      WEBSEARCH_COUNT: "3",
      WEBSEARCH_MAX_PROVIDERS: "2",
      WEBSEARCH_DEDUPE: "false",
      WEBSEARCH_CONFIG: "./cfg.json",
    });
  });

  it("never exports a name the gateway does not read into process.env", () => {
    // .env is data from the working directory, and a repository can ship one.
    // NODE_OPTIONS / LD_PRELOAD are acted on by the runtime itself, so letting
    // them through turns "run the MCP server in this folder" into code execution.
    const { env } = load("NODE_OPTIONS=--require=evil.js\nLD_PRELOAD=/tmp/evil.so\nPATH=/tmp\n__proto__=x\nconstructor=y");
    expect(env).toEqual({});
  });

  it("warns about an unrecognized gateway-shaped name but stays silent about unrelated ones", () => {
    const { env, warnings } = load("OTHER_API_KEY=k\nPATH=/tmp\nWEBSEARCH_COUNT=5");
    expect(env).toEqual({ WEBSEARCH_COUNT: "5" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("OTHER_API_KEY");
  });
});

describe("isGatewayEnvKey", () => {
  it("accepts the gateway variables and every slot variable the config layer reads", () => {
    for (const key of [
      "WEBSEARCH_ORDER",
      "WEBSEARCH_STRATEGY",
      "WEBSEARCH_TIMEOUT_MS",
      "WEBSEARCH_COUNT",
      "WEBSEARCH_MAX_PROVIDERS",
      "WEBSEARCH_DEDUPE",
      "WEBSEARCH_CONFIG",
      "ZHIPU_SEARCH_ENGINE",
      "KIMI_API_KEY",
      "MIMO_BASE_URL",
      "STEPFUN_MODEL",
      "ZHIPU_ENABLED",
      "KIMI_PRIORITY",
      "MIMO_TIMEOUT_MS",
    ]) {
      expect(isGatewayEnvKey(key)).toBe(true);
    }
  });

  it("rejects runtime-hijacking names, unknown slots and malformed names", () => {
    for (const key of [
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "NODE_ENV",
      "PATH",
      "HTTPS_PROXY",
      "OTHER_API_KEY",
      "KIMI_PASSWORD",
      "KIMI",
      "__PROTO__",
      // The slot suffix must be the exact name providerEnvKey builds: a
      // lower-cased variant is a name the config layer never reads, so
      // exporting it would only mislead.
      "mimo_base_url",
      "",
    ]) {
      expect(isGatewayEnvKey(key)).toBe(false);
    }
  });
});
