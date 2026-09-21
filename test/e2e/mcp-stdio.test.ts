/**
 * @file test/e2e/mcp-stdio
 * @description End-to-end MCP stdio protocol tests against the real binary.
 *
 * Responsibilities:
 * - Spawn the built server as a real subprocess and run the full MCP
 *   handshake (initialize → initialized → tools/list → tools/call)
 * - Drive every advertised tool and confirm the response shape matches what
 *   the tool layer (src/tools.ts) declares
 * - Confirm structured-error shape from tools/call when no provider is
 *   configured (the client must receive isError=true, not a thrown exception)
 * - Confirm the server's ready banner appears on stderr with the chain summary
 *
 * Why we use the SDK client: a hand-rolled JSON-RPC client can race with
 * transport.start() on Windows; the SDK client encapsulates that correctly
 * and is the same code real MCP clients use. The test still exercises the
 * real binary's JSON-RPC stack end-to-end via spawn + stdio frames.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PassThrough } from "node:stream";
import { cleanEnv, DIST_ENTRY, freshTempDir, removeDir } from "./_helpers.js";

const CLIENT_INFO = { name: "e2e-test", version: "0.0.0" };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[] };
}

interface CallResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface ServerInfo {
  name: string;
  version: string;
  capabilities?: { tools?: unknown };
}

let client: Client;
let transport: StdioClientTransport;
let readyStderr = "";
let tmpDir: string;

beforeEach(async () => {
  // Run in an empty temp dir so the project's real .env file does not leak
  // provider keys into the server-side runtime.
  tmpDir = freshTempDir();
  readyStderr = "";

  // StdioClientTransport starts the child on demand; attaching the stderr
  // listener *before* start() guarantees we catch the ready banner even if it
  // is written before client.connect() resolves.
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_ENTRY],
    env: cleanEnv(),
    cwd: tmpDir,
    stderr: "pipe",
  });
  const errSink = new PassThrough();
  errSink.setEncoding("utf8");
  errSink.on("data", (chunk: string) => (readyStderr += chunk));
  transport.stderr!.pipe(errSink);

  client = new Client(CLIENT_INFO, { capabilities: {} });
  await client.connect(transport);
});

afterEach(async () => {
  await client.close().catch(() => {});
  if (tmpDir) removeDir(tmpDir);
});

describe("MCP stdio protocol", () => {
  it("initialize returns server identity and tools capability", () => {
    const info = client.getServerVersion() as unknown as ServerInfo;
    expect(info.name).toBe("cn-websearch-mcp");
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    const caps = client.getServerCapabilities() as { tools?: unknown };
    expect(caps).toHaveProperty("tools");
  });

  it("tools/list returns both advertised tools with valid schemas", async () => {
    const { tools } = (await client.listTools()) as { tools: ToolDef[] };
    expect(tools).toHaveLength(2);

    const web = tools.find((t) => t.name === "web_search")!;
    expect(web).toBeDefined();
    expect(web.inputSchema.type).toBe("object");
    expect(web.inputSchema.properties).toHaveProperty("query");
    expect(web.inputSchema.properties).toHaveProperty("count");
    expect(web.inputSchema.properties).toHaveProperty("strategy");
    expect(web.inputSchema.required).toEqual(["query"]);

    const status = tools.find((t) => t.name === "provider_status")!;
    expect(status).toBeDefined();
    expect(status.inputSchema.type).toBe("object");
  });

  it("tools/call provider_status returns a structured status payload", async () => {
    const result = (await client.callTool({ name: "provider_status", arguments: {} })) as CallResult;
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");

    const payload = JSON.parse(result.content[0]!.text);
    expect(payload).toHaveProperty("strategy");
    expect(Array.isArray(payload.providers)).toBe(true);
    const byName = new Map<string, { configured: boolean; in_chain: boolean }>();
    for (const p of payload.providers) byName.set(p.name, p);
    for (const name of ["stepfun", "kimi", "zhipu", "mimo"]) {
      const entry = byName.get(name);
      expect(entry, `provider ${name} present`).toBeDefined();
      expect(entry!.configured).toBe(false);
      expect(entry!.in_chain).toBe(false);
    }
    // Defensive: no key-shaped substring in the response.
    expect(result.content[0]!.text).not.toMatch(/sk-[A-Za-z0-9._-]{12,}/);
  });

  it("tools/call web_search without a query returns isError=true with a structured message", async () => {
    const result = (await client.callTool({
      name: "web_search",
      arguments: { query: "" },
    })) as CallResult;
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.error).toMatch(/query/i);
  });

  it("tools/call web_search with an unknown provider returns isError=true, not a crash", async () => {
    const result = (await client.callTool({
      name: "web_search",
      arguments: { query: "hello", providers: ["openai"] },
    })) as CallResult;
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.error).toMatch(/unknown provider/i);
  });

  it("tools/call web_search with an invalid strategy returns isError=true", async () => {
    const result = (await client.callTool({
      name: "web_search",
      arguments: { query: "hello", strategy: "nonsense" },
    })) as CallResult;
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.error).toMatch(/strategy/);
  });

  it("tools/call with an unknown tool name returns isError=true", async () => {
    const result = (await client.callTool({
      name: "no_such_tool",
      arguments: {},
    })) as CallResult;
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.error).toMatch(/unknown tool/);
  });

  it("server logs a ready line on stderr with chain summary", () => {
    // The sink was attached before connect(), so the ready banner is already
    // captured. Assert it directly.
    expect(readyStderr).toMatch(/cn-websearch-mcp.*v\d+\.\d+\.\d+ ready/);
    expect(readyStderr).toContain("strategy:");
    // No keys configured in test env → the chain is empty and the banner must say so.
    expect(readyStderr).toContain("(none configured)");
  });
});