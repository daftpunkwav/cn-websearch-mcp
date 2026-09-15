/**
 * @file test/cli-args
 * @description CLI argument parsing unit tests: command recognition, both option syntaxes, query assembly and error paths.
 */

import { describe, expect, it } from "vitest";
import { parseArgs, usage } from "../src/cli/args.js";

function ok(argv: string[]) {
  const res = parseArgs(argv);
  if (!res.ok) throw new Error(`expected success, got: ${res.message}`);
  return res.args;
}

function fail(argv: string[]) {
  const res = parseArgs(argv);
  if (res.ok) throw new Error(`expected failure, got command ${res.args.command}`);
  return res.message;
}

describe("parseArgs", () => {
  it("defaults to the MCP serve command when there are no arguments", () => {
    expect(ok([])).toMatchObject({ command: "serve", query: "", json: false });
  });

  it("recognises commands and their aliases", () => {
    expect(ok(["serve"]).command).toBe("serve");
    expect(ok(["mcp"]).command).toBe("serve");
    expect(ok(["status"]).command).toBe("status");
    expect(ok(["repl"]).command).toBe("repl");
    expect(ok(["shell"]).command).toBe("repl");
    expect(ok(["interactive"]).command).toBe("repl");
    expect(ok(["version"]).command).toBe("version");
    expect(ok(["help"]).command).toBe("help");
  });

  it("joins bare words into the query", () => {
    expect(ok(["search", "最近一周", "大模型"]).query).toBe("最近一周 大模型");
    expect(ok(["search", "hello world"]).query).toBe("hello world");
  });

  it("handles -h/--help and -v/--version short-circuits", () => {
    expect(ok(["-h"]).command).toBe("help");
    expect(ok(["search", "--help"]).command).toBe("help");
    expect(ok(["-v"]).command).toBe("version");
    expect(ok(["search", "--version"]).command).toBe("version");
  });

  it("accepts both --opt value and --opt=value", () => {
    expect(ok(["search", "q", "--count", "5"]).count).toBe(5);
    expect(ok(["search", "q", "--count=5"]).count).toBe(5);
    expect(ok(["search", "q", "-n", "3"]).count).toBe(3);
    expect(ok(["search", "q", "--strategy=aggregate"]).strategy).toBe("aggregate");
    expect(ok(["search", "q", "--providers=stepfun,zhipu"]).providers).toEqual(["stepfun", "zhipu"]);
  });

  it("supports --json, --no-dedupe and -q", () => {
    expect(ok(["status", "--json"]).json).toBe(true);
    expect(ok(["search", "q", "--no-dedupe"]).dedupe).toBe(false);
    expect(ok(["test", "-q", "custom probe"]).query).toBe("custom probe");
  });

  it("combines --query with trailing words", () => {
    expect(ok(["test", "-q", "first", "second"]).query).toBe("first second");
  });

  it("favours the last provided list/number value", () => {
    expect(ok(["search", "q", "--count=2", "--count=4"]).count).toBe(4);
  });

  it("rejects unknown commands with a hint", () => {
    expect(fail(["serach"])).toContain("unknown command: serach");
    expect(fail(["serach"])).toContain("`search serach`");
  });

  it("rejects unknown options", () => {
    expect(fail(["search", "q", "--bogus"])).toBe("unknown option: --bogus");
    expect(fail(["search", "q", "-x"])).toBe("unknown option: -x");
  });

  it("rejects invalid option values", () => {
    expect(fail(["search", "q", "--count"])).toContain("invalid --count value: (missing)");
    expect(fail(["search", "q", "--count", "abc"])).toContain("invalid --count value: abc");
    expect(fail(["search", "q", "--count", "0"])).toContain("invalid --count value: 0");
    expect(fail(["search", "q", "--strategy", "turbo"])).toContain("invalid --strategy value: turbo");
    expect(fail(["search", "q", "--strategy"])).toContain("invalid --strategy value: (missing)");
    expect(fail(["search", "q", "--providers"])).toBe("missing value for --providers");
    expect(fail(["test", "--query"])).toBe("missing value for --query");
  });

  it("rejects an empty provider list", () => {
    expect(fail(["search", "q", "--providers=,"])).toContain("invalid --providers value");
  });

  it("does not treat a following flag as an option value", () => {
    expect(fail(["search", "--count", "--json"])).toContain("invalid --count value: (missing)");
  });
});

describe("usage", () => {
  it("documents every command and the default serve behaviour", () => {
    const text = usage();
    for (const token of ["search", "status", "test", "repl", "help", "version", "--strategy", "--providers"]) {
      expect(text).toContain(token);
    }
    expect(text).toContain("stdio");
  });
});
