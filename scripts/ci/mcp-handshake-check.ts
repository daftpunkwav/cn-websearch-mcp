/**
 * @file scripts/ci/mcp-handshake-check
 * @description Start the built MCP server and complete one initialize handshake.
 *
 * Responsibilities:
 * - Spawn `dist/index.js` as a real subprocess with no provider key in its env
 * - Complete the MCP initialize handshake and read the advertised tool list
 * - Exit 0 when the server answers, 1 on any failure or timeout
 *
 * Why this exists: the vitest suite needs Node 20, so the Node 18 matrix row
 * compiles the package but cannot run the suite. This check runs the shipped
 * artifact on that runtime, so a regression in the server path fails CI
 * instead of reaching the people who install the package.
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

/** Reject when the awaited work outlives its budget. */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
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
  // The ready banner is informational here. Drain it so the child never
  // blocks on a full pipe, and keep its tail for the failure message.
  let serverLog = '';
  const errSink = new PassThrough();
  errSink.setEncoding('utf8');
  errSink.on('data', (chunk: string) => {
    serverLog = (serverLog + chunk).slice(-2000);
  });
  transport.stderr?.pipe(errSink);

  const client = new Client({ name: 'handshake-check', version: '0.0.0' }, { capabilities: {} });
  try {
    await withTimeout(
      client.connect(transport),
      HANDSHAKE_TIMEOUT_MS,
      `initialize handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms`,
    );
    const info = client.getServerVersion();
    if (info?.name !== 'cn-websearch-mcp') {
      throw new Error(`unexpected server name: ${JSON.stringify(info?.name ?? null)}`);
    }
    const { tools } = await client.listTools();
    if (!tools.some((tool) => tool.name === 'web_search')) {
      throw new Error(`web_search not advertised (tools: ${tools.map((tool) => tool.name).join(', ') || 'none'})`);
    }
    console.log(`mcp-handshake-check: OK (${info.name} v${info.version}, ${tools.length} tools)`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${reason}\nserver stderr:\n${serverLog.trim() || '(empty)'}`);
  } finally {
    await client.close().catch(() => {});
    rmSync(cwd, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(`mcp-handshake-check: FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
