/**
 * @file test/index
 * @description Entry point assembly unit tests: handler registration, auto-start detection and fatal-error exit.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Mock the two SDK components used by the entry point assembly; keep the real types module
// so the handler keys are still the real schema objects.
const mocks = vi.hoisted(() => ({
  setRequestHandler: vi.fn(),
  connect: vi.fn(async () => {}),
  transportsCreated: 0,
}));

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class {
    setRequestHandler = mocks.setRequestHandler;
    connect = mocks.connect;
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {
    constructor() {
      mocks.transportsCreated++;
    }
  },
}));

async function importEntryPoint() {
  vi.resetModules();
  mocks.setRequestHandler.mockClear();
  mocks.connect.mockClear();
  mocks.transportsCreated = 0;
  return import("../src/index.js");
}

describe("server entry point", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("registers both MCP handlers without starting the stdio loop on import", async () => {
    await importEntryPoint();
    expect(mocks.setRequestHandler).toHaveBeenCalledTimes(2);
    const [listKey] = mocks.setRequestHandler.mock.calls[0]!;
    const [callKey] = mocks.setRequestHandler.mock.calls[1]!;
    expect(listKey).toBe(ListToolsRequestSchema);
    expect(callKey).toBe(CallToolRequestSchema);
    expect(mocks.transportsCreated).toBe(0);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("tools/list handler returns the two definitions", async () => {
    const mod = await importEntryPoint();
    const listHandler = mocks.setRequestHandler.mock.calls[0]![1] as () => Promise<{ tools: unknown[] }>;
    const res = await listHandler();
    expect(res.tools).toHaveLength(2);
    void mod;
  });

  it("tools/call handler dispatches to the tool layer", async () => {
    const mod = await importEntryPoint();
    const callHandler = mocks.setRequestHandler.mock.calls[1]![1] as (
      req: { params: { name: string; arguments?: Record<string, unknown> } },
    ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    const res = await callHandler({ params: { name: "provider_status" } });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0]!.text)).toHaveProperty("providers");
    void mod;
  });

  it("does not auto-start when argv[1] is undefined", async () => {
    const original = process.argv[1];
    process.argv[1] = undefined as unknown as string;
    try {
      await importEntryPoint();
    } finally {
      process.argv[1] = original;
    }
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("auto-starts the MCP server when executed as the entry script with no arguments", async () => {
    const { fileURLToPath } = await import("node:url");
    const original = [...process.argv];
    // Point argv[1] at the module's own file with no extra args so isMain holds and the default serve runs.
    process.argv = [original[0] ?? "node", fileURLToPath(new URL("../src/index.ts", import.meta.url))];
    try {
      await importEntryPoint();
      // Give the fire-and-forget start() an event loop tick to run.
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      process.argv = original;
    }
    expect(mocks.connect).toHaveBeenCalled();
  });

  it("dispatches CLI commands when arguments are present", async () => {
    const { fileURLToPath } = await import("node:url");
    const original = [...process.argv];
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    // argv[1] must be the module's own path (isMain); CLI arguments come after argv[2].
    process.argv = [
      original[0] ?? "node",
      fileURLToPath(new URL("../src/index.ts", import.meta.url)),
      "version",
    ];
    try {
      await importEntryPoint();
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      process.argv = original;
    }
    // version takes the CLI branch: the stdio transport must not start.
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(outSpy.mock.calls.flat().join("")).toMatch(/\d+\.\d+\.\d+/);
    outSpy.mockRestore();
  });

  it("main() connects a stdio transport and logs the ready line", async () => {
    const original = [...process.argv];
    process.argv = [original[0] ?? "node", original[1] ?? "x"];
    try {
      const mod = await importEntryPoint();
      await mod.main();
      expect(mocks.transportsCreated).toBe(1);
      expect(mocks.connect).toHaveBeenCalledExactlyOnceWith(expect.anything());
    } finally {
      process.argv = original;
    }
  });

  it("start() reports fatal errors and exits non-zero", async () => {
    const original = [...process.argv];
    process.argv = [original[0] ?? "node", original[1] ?? "x"];
    const mod = await importEntryPoint();
    mocks.connect.mockRejectedValueOnce(new Error("boom"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exited");
    }) as never);
    try {
      await expect(mod.start()).rejects.toThrow("exited");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      process.argv = original;
    }
  });

  it("start() exits with the usage code on a bad command line", async () => {
    const original = [...process.argv];
    process.argv = [original[0] ?? "node", "cn-websearch-mcp", "--bogus"];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const mod = await importEntryPoint();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exited");
    }) as never);
    try {
      await expect(mod.start()).rejects.toThrow("exited");
      expect(exitSpy).toHaveBeenCalledWith(2);
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
      process.argv = original;
    }
  });
});
