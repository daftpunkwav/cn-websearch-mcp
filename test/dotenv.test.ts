/**
 * @file test/dotenv
 * @description .env loader unit tests: key/value parsing, quote stripping, never overwriting existing variables.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotEnv } from "../src/dotenv.js";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "cwsmcp-env-"));
}

describe("loadDotEnv", () => {
  it("loads KEY=VALUE pairs and strips quotes", () => {
    const dir = makeDir();
    try {
      writeFileSync(join(dir, ".env"), 'A=1\nB="two words"\nC=\'three\'\n\n# comment\n=D\nE');
      const env: Record<string, string> = {};
      loadDotEnv(dir, env as NodeJS.ProcessEnv);
      expect(env).toEqual({ A: "1", B: "two words", C: "three" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never overwrites existing entries", () => {
    const dir = makeDir();
    try {
      writeFileSync(join(dir, ".env"), "A=from-file");
      const env = { A: "from-process" } as unknown as NodeJS.ProcessEnv;
      loadDotEnv(dir, env);
      expect(env.A).toBe("from-process");
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
    const dir = makeDir();
    try {
      writeFileSync(join(dir, ".env"), "URL=https://x.example/a=b");
      const env: Record<string, string> = {};
      loadDotEnv(dir, env as NodeJS.ProcessEnv);
      expect(env.URL).toBe("https://x.example/a=b");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes keys colliding with Object.prototype members (Object.hasOwn check)", () => {
    const dir = makeDir();
    try {
      writeFileSync(join(dir, ".env"), "toString=from-file");
      const env: Record<string, string> = {};
      loadDotEnv(dir, env as NodeJS.ProcessEnv);
      // The old implementation used `key in env` for existence and would mistakenly see the
      // prototype-chain toString as already present, skipping it.
      expect(env).toEqual({ toString: "from-file" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
