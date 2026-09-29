/**
 * @file test/dotenv
 * @description .env loader unit tests: key/value parsing, quote stripping, never overwriting existing variables, and refusing names the gateway does not read.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotEnv } from "../src/dotenv.js";
import { gatewayEnvKeys } from "../src/config.js";

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

  it("treats a .env that cannot be read as no .env at all", () => {
    // Size is measured with statSync and the read happens separately, so a path
    // that stats successfully but cannot be read reaches the second step. A
    // directory named `.env` is the reproducible case: it stats at 0 bytes (so
    // it passes the size check) and then fails the read. The contract is the
    // same one a missing file has — no keys exported, and no throw out of a
    // loader the entry point calls at module scope, where an exception would
    // stop the server from starting at all.
    const dir = makeDir();
    try {
      mkdirSync(join(dir, ".env"));
      const env: Record<string, string> = {};
      const warnings: string[] = [];
      expect(() => loadDotEnv(dir, env as NodeJS.ProcessEnv, (m) => warnings.push(m))).not.toThrow();
      expect(env).toEqual({});
      // Nothing was read, so nothing is worth reporting.
      expect(warnings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a file too large to be configuration, and reports it", () => {
    // The working directory is not necessarily trusted, so an oversized .env is
    // a file to decline rather than read. It has to be reported: a gateway that
    // silently loaded no keys is indistinguishable from an unconfigured one. The
    // padding is generated here, never committed.
    const dir = makeDir();
    try {
      writeFileSync(join(dir, ".env"), `KIMI_API_KEY=real\n#${"x".repeat(70 * 1024)}`);
      const env: Record<string, string> = {};
      const warnings: string[] = [];
      loadDotEnv(dir, env as NodeJS.ProcessEnv, (m) => warnings.push(m));
      expect(env).toEqual({});
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("too large");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe("the .env whitelist is the config layer's own list", () => {
  it("accepts every gateway variable and every slot variable the config layer reads", () => {
    const { env } = load(
      [
        "WEBSEARCH_ORDER=zhipu,kimi",
        "WEBSEARCH_STRATEGY=aggregate",
        "WEBSEARCH_TIMEOUT_MS=999",
        "WEBSEARCH_COUNT=3",
        "WEBSEARCH_MAX_PROVIDERS=2",
        "WEBSEARCH_DEDUPE=false",
        "WEBSEARCH_CONFIG=./cfg.json",
        "ZHIPU_SEARCH_ENGINE=search_pro",
        "KIMI_API_KEY=1",
        "MIMO_BASE_URL=https://mimo.example",
        "STEPFUN_MODEL=step-model",
        "ZHIPU_ENABLED=false",
        "KIMI_PRIORITY=3",
        "MIMO_TIMEOUT_MS=1234",
      ].join("\n"),
    );
    expect(env).toEqual({
      WEBSEARCH_ORDER: "zhipu,kimi",
      WEBSEARCH_STRATEGY: "aggregate",
      WEBSEARCH_TIMEOUT_MS: "999",
      WEBSEARCH_COUNT: "3",
      WEBSEARCH_MAX_PROVIDERS: "2",
      WEBSEARCH_DEDUPE: "false",
      WEBSEARCH_CONFIG: "./cfg.json",
      ZHIPU_SEARCH_ENGINE: "search_pro",
      KIMI_API_KEY: "1",
      MIMO_BASE_URL: "https://mimo.example",
      STEPFUN_MODEL: "step-model",
      ZHIPU_ENABLED: "false",
      KIMI_PRIORITY: "3",
      MIMO_TIMEOUT_MS: "1234",
    });
    // Every one of those names is on the list config.ts owns, so adding a
    // setting there is enough to make it settable from .env — the whitelist is
    // not restated in this module and therefore cannot drift away from it.
    for (const key of Object.keys(env)) expect(gatewayEnvKeys().has(key), key).toBe(true);
  });

  it("refuses runtime-hijacking names, unknown slots and malformed names", () => {
    const rejected = [
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
      "KIMI_API_KEY_EXTRA",
    ];
    const { env } = load(rejected.map((k) => `${k}=v`).join("\n"));
    expect(env).toEqual({});
  });
});
