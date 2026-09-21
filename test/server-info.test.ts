/**
 * @file test/server-info
 * @description Server identity constant unit tests: name and version kept mechanically in sync with package.json.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SERVER_NAME, SERVER_VERSION } from "../src/server-info.js";

// Read the ground truth from the repo-root package.json so version drift surfaces at test time,
// instead of being discovered only after release when dist reports an old version number.
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
  name: string;
  version: string;
};

describe("server-info", () => {
  it("keeps SERVER_NAME in sync with package.json", () => {
    expect(SERVER_NAME).toBe(pkg.name);
  });

  it("keeps SERVER_VERSION in sync with package.json", () => {
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  it("keeps the lock file root version in sync with package.json", () => {
    // npm ci fails outright when the lock file's root version drifts from package.json,
    // so the mismatch must surface in tests rather than only on the CI runner.
    const lock = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package-lock.json", import.meta.url)), "utf8"),
    ) as { version?: string; packages?: { "": { version?: string } } };
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages?.[""]?.version).toBe(pkg.version);
  });
});
