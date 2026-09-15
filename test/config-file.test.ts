/**
 * @file test/config-file
 * @description Config file I/O unit tests: path resolution, JSON parsing and graceful degradation on failures.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILENAME, readConfigFile, resolveConfigPath } from "../src/config-file.js";

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
});
