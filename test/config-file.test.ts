/**
 * @file test/config-file
 * @description Config file I/O unit tests: path resolution, JSON parsing and graceful degradation on failures.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILENAME, readConfigFile, resolveConfigPath, type ReadFileFn } from "../src/config-file.js";

describe("resolveConfigPath", () => {
  it("prefers the explicit WEBSEARCH_CONFIG path", () => {
    expect(resolveConfigPath({ WEBSEARCH_CONFIG: " /tmp/cfg.json " }, "/cwd", () => false)).toBe("/tmp/cfg.json");
  });

  it("uses the conventional filename when it exists in cwd", () => {
    const seen: string[] = [];
    const path = resolveConfigPath({}, "/cwd", (p) => {
      seen.push(p);
      return true;
    });
    expect(path).toContain(CONFIG_FILENAME);
    expect(seen).toHaveLength(1);
  });

  it("returns undefined when nothing is configured", () => {
    expect(resolveConfigPath({}, "/cwd", () => false)).toBeUndefined();
  });
});

describe("readConfigFile", () => {
  it("parses a JSON object", () => {
    const cfg = readConfigFile("/cfg.json", () => {}, () => '{"strategy":"aggregate"}');
    expect(cfg).toEqual({ strategy: "aggregate" });
  });

  it("parses JSON with a leading UTF-8 BOM (common in Windows-edited files)", () => {
    const cfg = readConfigFile("/bom.json", () => {}, () => "\uFEFF{\"strategy\":\"aggregate\"}");
    expect(cfg).toEqual({ strategy: "aggregate" });
  });

  it("never echoes credential-looking config content in JSON error warnings", () => {
    const warnings: string[] = [];
    // Some V8 versions include a source snippet in JSON syntax errors; the file
    // may hold API keys, so the warning must be redacted before it reaches stderr.
    const raw = `{"providers":{"kimi":{"apiKey":"sk-abcdefghijklmnop123"}},}`;
    expect(readConfigFile("/bad.json", (m) => warnings.push(m), () => raw)).toBeUndefined();
    expect(warnings[0]).toContain("not valid JSON");
    expect(warnings.join("\n")).not.toContain("sk-abcdefghijklmnop123");
  });

  it("warns and returns undefined when the file cannot be read", () => {
    const warnings: string[] = [];
    const cfg = readConfigFile("/missing.json", (m) => warnings.push(m), () => {
      throw new Error("ENOENT");
    });
    expect(cfg).toBeUndefined();
    expect(warnings[0]).toContain("/missing.json");
    expect(warnings[0]).toContain("ENOENT");
  });

  it("warns and returns undefined on invalid JSON", () => {
    const warnings: string[] = [];
    expect(readConfigFile("/bad.json", (m) => warnings.push(m), () => "{oops")).toBeUndefined();
    expect(warnings[0]).toContain("not valid JSON");
  });

  it("rejects non-object payloads (null, array, scalar)", () => {
    const warnings: string[] = [];
    const warn = (m: string): number => warnings.push(m);
    expect(readConfigFile("/a.json", warn, () => "null")).toBeUndefined();
    expect(readConfigFile("/a.json", warn, () => "[1,2]")).toBeUndefined();
    expect(readConfigFile("/a.json", warn, () => '"x"')).toBeUndefined();
    expect(warnings.every((w) => w.includes("must contain a JSON object"))).toBe(true);
    expect(warnings).toHaveLength(3);
  });

  it("warns with a stringified reason for non-Error throws", () => {
    const warnings: string[] = [];
    expect(
      readConfigFile("/x.json", (m) => warnings.push(m), () => {
        throw "plain string";
      }),
    ).toBeUndefined();
    expect(warnings[0]).toContain("plain string");
  });

  it("reads a real file from disk through the default reader", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwsmcp-cfg-"));
    try {
      const path = join(dir, "cn-websearch.config.json");
      writeFileSync(path, '{"strategy":"aggregate","count":3}');
      expect(readConfigFile(path, () => {})).toMatchObject({ strategy: "aggregate", count: 3 });
      // A missing path exercises the failure side of the same branch.
      const warnings: string[] = [];
      expect(readConfigFile(join(dir, "nope.json"), (m) => warnings.push(m))).toBeUndefined();
      expect(warnings[0]).toContain("not readable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a file too large to be configuration, through the same warn path", () => {
    // The config path can sit in an untrusted cwd and is read synchronously, so
    // an enormous file must be measured before it is buffered. The refusal
    // travels the existing unreadable path: a warning, and undefined so the
    // gateway keeps running. The padding is generated here, never committed.
    const dir = mkdtempSync(join(tmpdir(), "cwsmcp-bigcfg-"));
    try {
      const path = join(dir, "cn-websearch.config.json");
      writeFileSync(path, `{"pad":"${"x".repeat(1024 * 1024 + 1)}"}`);
      const warnings: string[] = [];
      expect(readConfigFile(path, (m) => warnings.push(m))).toBeUndefined();
      expect(warnings[0]).toContain("not readable");
      expect(warnings[0]).toContain("over the");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts credential-looking text from both warning paths", () => {
    // The file may hold API keys, so nothing from a read failure or a parse
    // failure may reach stderr unscrubbed.
    const readWarnings: string[] = [];
    const failing: ReadFileFn = () => {
      throw new Error("EACCES: permission denied while opening for key sk-EXAMPLEKEY01234567890");
    };
    expect(readConfigFile("/tmp/cn.json", (m) => readWarnings.push(m), failing)).toBeUndefined();
    expect(readWarnings[0]).toContain("not readable");
    expect(readWarnings[0]).not.toContain("EXAMPLEKEY01234567890");

    const parseWarnings: string[] = [];
    const withKey = () => '{"providers":{"kimi":{"apiKey":"sk-EXAMPLEKEY01234567890"}}} broken';
    expect(readConfigFile("/tmp/cn.json", (m) => parseWarnings.push(m), withKey)).toBeUndefined();
    expect(parseWarnings[0]).not.toContain("EXAMPLEKEY01234567890");
  });
});
