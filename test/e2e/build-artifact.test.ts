/**
 * @file test/e2e/build-artifact
 * @description End-to-end checks that the build output is a usable, self-contained MCP server.
 *
 * Responsibilities:
 * - Confirm the build step is part of the test workflow (this test fails fast if dist/ is missing)
 * - Confirm `node dist/index.js version` / `help` succeed and report correct identity
 * - Confirm the entry is parseable as an ESM module (Node treats it as one when invoked)
 *
 * Why: nothing else in the suite exercises the compiled artifact; a passing
 * unit suite with a stale dist/ would still ship a broken binary.
 */

import { describe, expect, it } from "vitest";
import { existsSync, statSync } from "node:fs";
import { DIST_ENTRY, PKG_ROOT, runCli, runCliInEphemeralCwd } from "./_helpers.js";

describe("build artifact", () => {
  it("dist/index.js exists and is a real file", () => {
    expect(existsSync(DIST_ENTRY)).toBe(true);
    const st = statSync(DIST_ENTRY);
    expect(st.isFile()).toBe(true);
    // Sanity floor: a broken / empty compile would still produce a tiny file.
    expect(st.size).toBeGreaterThan(500);
  });

  it("version command prints the package name and a semver-like version", async () => {
    const { code, stdout, stderr } = await runCli(["version"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const trimmed = stdout.trim();
    expect(trimmed).toMatch(/^cn-websearch-mcp \d+\.\d+\.\d+/);
  });

  it("help command lists every command and exits 0", async () => {
    const { code, stdout, stderr } = await runCli(["help"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Usage:");
    for (const cmd of ["search", "status", "test", "repl", "help", "version"]) {
      expect(stdout).toContain(cmd);
    }
  });

  it("missing an unknown subcommand returns the usage exit code and prints usage", async () => {
    const { code, stdout, stderr } = await runCli(["--bogus"]);
    expect(code).toBe(2);
    expect(stderr).toContain("error: unknown option: --bogus");
    expect(stderr).toContain("Usage:");
    expect(stdout).toBe("");
  });

  it("status works with no provider keys (deterministic, no upstream calls)", async () => {
    // Run in an empty temp cwd so the project's real .env file does not
    // activate providers — otherwise the table would show configured=yes.
    const { code, stdout } = await runCliInEphemeralCwd(["status"]);
    expect(code).toBe(0);
    expect(stdout).toContain("strategy");
    expect(stdout).toContain("provider");
    // Every provider should appear as enabled=yes, configured=no, in-chain=no (no upstream calls).
    // The columns in the table are: name, enabled, configured, in-chain, priority, model.
    for (const name of ["kimi", "stepfun", "zhipu", "mimo"]) {
      const re = new RegExp(`${name}\\s+(yes|no)\\s+(yes|no)\\s+(yes|no)\\s+`);
      expect(stdout).toMatch(re);
      // Specified providers' enabled/configured/in-chain tuple must be yes/no/no.
      const m = re.exec(stdout)!;
      expect(m[1]).toBe("yes");
      expect(m[2]).toBe("no");
      expect(m[3]).toBe("no");
    }
    // The footer line is the unmistakable "no provider is ready" message.
    expect(stdout).toContain("no provider is ready");
  });

  it("exit code 1 is reported when `search` has no ready provider", async () => {
    const { code, stderr } = await runCliInEphemeralCwd(["search", "anything"]);
    expect(code).toBe(1);
    expect(stderr).toContain("no provider is ready");
  });

  it("binary lives at the project root path advertised in package.json bin field", async () => {
    // The package.json `bin.cn-websearch-mcp` field points at dist/index.js; this guards against
    // an accidental path change in the manifest that the unit tests wouldn't notice.
    const pkg = await import("../../package.json", { with: { type: "json" } });
    const bin = (pkg.default as { bin: Record<string, string> }).bin["cn-websearch-mcp"];
    expect(bin).toBe("dist/index.js");
    // And the file we tested above lives at <pkg root>/<bin>.
    const normalized = `${PKG_ROOT.replace(/\\/g, "/")}/${bin.replace(/\\/g, "/")}`;
    expect(normalized.replace(/\/+/g, "/")).toBe(DIST_ENTRY.replace(/\\/g, "/"));
  });
});