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
});
