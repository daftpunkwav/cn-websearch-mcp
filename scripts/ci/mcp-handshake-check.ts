/**
 * @file scripts/ci/mcp-handshake-check
 * @description Start the built MCP server and complete one initialize handshake.
 *
 * Responsibilities:
 * - Spawn `dist/index.js` as a real subprocess with no provider key in its env
 * - Complete the MCP initialize handshake and read the advertised tool list
 * - Exit 0 when the server answers, 1 on any failure or timeout
 *
 * Why this exists: the vitest suite supports Node ^20, ^22 and >=24, so the
 * Node 18 matrix row compiles the package but cannot run the suite. This check
 * runs the shipped artifact on that runtime, so a regression in the server
 * path fails CI instead of reaching the people who install the package.
 *
 * It runs through tsx, like the other TypeScript scripts here: the TypeScript
 * under test/e2e/ needs the vitest runner, and Node 18 - the runtime this
 * check exists for - runs neither.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_ENTRY = resolve(REPO_ROOT, 'dist', 'index.js');
const HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * Environment for the child: only what node needs to start. Nothing is
 * inherited, so no provider key can reach the server and every channel is
 * seen as unconfigured.
 */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'SystemRoot', 'PATHEXT', 'TMP', 'TEMP', 'HOME', 'LANG']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Reject when the awaited work outlives the remaining budget. */
async function withDeadline<T>(promise: Promise<T>, deadline: number, message: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(message);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), remaining);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drain the server's stderr. The ready banner is informational here, but the
 * child must never block on a full pipe; the tail is kept for the failure
 * message.
 */
function drainStderr(transport: StdioClientTransport): () => string {
  let log = '';
  const sink = new PassThrough();
  sink.setEncoding('utf8');
  sink.on('data', (chunk: string) => {
    log = (log + chunk).slice(-2000);
  });
  transport.stderr?.pipe(sink);
  return () => log;
}

/** The identity the server reported during the handshake. */
function serverIdentity(client: Client): { name: string; version: string } {
  const info = client.getServerVersion();
  if (info?.name !== 'cn-websearch-mcp') {
    throw new Error(`unexpected server name: ${JSON.stringify(info?.name ?? null)}`);
  }
  return { name: info.name, version: info.version };
}

/** The tools the server advertises, with the gateway tool among them. */
async function advertisedTools(client: Client, deadline: number): Promise<Tool[]> {
  const { tools } = await withDeadline(
    client.listTools(),
    deadline,
    `tools/list timed out after ${HANDSHAKE_TIMEOUT_MS}ms`,
  );
  if (!tools.some((tool) => tool.name === 'web_search')) {
    throw new Error(`web_search not advertised (tools: ${tools.map((tool) => tool.name).join(', ') || 'none'})`);
  }
  return tools;
}

async function main(): Promise<void> {
  // A fresh empty cwd keeps the project's own .env out of the child: the
  // server has to start with no channel configured.
  const cwd = mkdtempSync(join(tmpdir(), 'cn-websearch-handshake-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_ENTRY],
    env: cleanEnv(),
    cwd,
    stderr: 'pipe',
  });
  const serverLog = drainStderr(transport);
  const client = new Client({ name: 'handshake-check', version: '0.0.0' }, { capabilities: {} });
  // One budget for the whole exchange: a server that answers `initialize` and
  // then goes quiet must not park the check on an unanswered `tools/list`.
  const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
  try {
    await withDeadline(
      client.connect(transport),
      deadline,
      `initialize handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms`,
    );
    const info = serverIdentity(client);
    const tools = await advertisedTools(client, deadline);
    console.log(`mcp-handshake-check: OK (${info.name} v${info.version}, ${tools.length} tools)`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${reason}\nserver stderr:\n${serverLog().trim() || '(empty)'}`);
  } finally {
    await client.close().catch(() => {});
    rmSync(cwd, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(`mcp-handshake-check: FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
