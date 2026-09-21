/**
 * @file test/e2e/_helpers
 * @description Shared infrastructure for end-to-end tests.
 *
 * Responsibilities:
 * - Spawn the built entry point as a real subprocess (Node child_process)
 * - Provide a clean env helper that strips provider keys so E2E runs never
 *   accidentally hit a real upstream API (we only test the protocol/process layer)
 * - Provide a tiny JSON-RPC client that speaks the stdio framing the MCP SDK uses
 *   (Content-Length: N\r\n\r\n<body>) so a single MCP message round-trip can be tested
 *
 * Tests using these helpers must NEVER inject real API keys. Live upstream tests
 * live in scripts/smoke.ts and run via `npm run smoke`, separately from vitest.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = resolve(HERE, "..", "..");
export const DIST_ENTRY = resolve(PKG_ROOT, "dist", "index.js");
export const SRC_ENTRY = resolve(PKG_ROOT, "src", "index.ts");

/** Provider key variables the runtime reads; clearing these keeps E2E hermetic. */
const PROVIDER_KEY_VARS = [
  "STEPFUN_API_KEY",
  "STEPFUN_BASE_URL",
  "STEPFUN_MODEL",
  "STEPFUN_ENABLED",
  "STEPFUN_PRIORITY",
  "STEPFUN_TIMEOUT_MS",
  "KIMI_API_KEY",
  "KIMI_BASE_URL",
  "KIMI_MODEL",
  "KIMI_ENABLED",
  "KIMI_PRIORITY",
  "KIMI_TIMEOUT_MS",
  "MIMO_API_KEY",
  "MIMO_BASE_URL",
  "MIMO_MODEL",
  "MIMO_ENABLED",
  "MIMO_PRIORITY",
  "MIMO_TIMEOUT_MS",
  "ZHIPU_API_KEY",
  "ZHIPU_BASE_URL",
  "ZHIPU_MODEL",
  "ZHIPU_ENABLED",
  "ZHIPU_PRIORITY",
  "ZHIPU_TIMEOUT_MS",
  "ZHIPU_SEARCH_ENGINE",
];

/** Generic gateway control variables (not provider-specific). */
const GATEWAY_KEY_VARS = [
  "WEBSEARCH_STRATEGY",
  "WEBSEARCH_ORDER",
  "WEBSEARCH_COUNT",
  "WEBSEARCH_TIMEOUT_MS",
  "WEBSEARCH_DEDUPE",
  "WEBSEARCH_CONFIG",
  "WEBSEARCH_MAX_PROVIDERS",
];

/**
 * Build an env map with all provider / gateway variables cleared so the
 * subprocess has no usable API keys (the runtime sees every provider as
 * disabled / missing-key). Path / locale vars are preserved so the binary
 * can still launch.
 *
 * Important: variables are *removed* (not set to "") so the in-process dotenv
 * loader can still fill them from a .env file when the test CWD provides one.
 * Setting them to "" would satisfy Object.hasOwn() and suppress .env loading,
 * which is exactly what the priority-chain tests want to detect.
 */
export function cleanEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const v of [...PROVIDER_KEY_VARS, ...GATEWAY_KEY_VARS]) env[v] = "";
  // Strip the provider / gateway vars entirely so the child sees them as
  // unset; this matches how a real MCP client launches the binary without any
  // pre-existing env.
  for (const v of [...PROVIDER_KEY_VARS, ...GATEWAY_KEY_VARS]) delete env[v];
  // Minimal passthrough so node itself can start.
  for (const k of ["PATH", "SystemRoot", "PATHEXT", "TMP", "TEMP"]) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return { ...env, ...overrides };
}

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  /** Wall-clock duration from spawn to close. */
  durationMs: number;
}

/**
 * Make a fresh empty temp directory. Tests that need a deterministic
 * "no provider keys available" environment must spawn the binary with cwd
 * pointing here, because the project root has a real .env file that the
 * in-process dotenv loader will pick up otherwise.
 */
export function freshTempDir(prefix = "cn-websearch-e2e-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Recursively delete a directory (no-op if missing). Safe to call after tests. */
export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Run the built CLI to completion and capture both streams. Throws on timeout. */
export async function runCli(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number; input?: string } = {},
): Promise<SpawnResult> {
  const t0 = Date.now();
  return new Promise((resolveP, reject) => {
    const proc = spawn(process.execPath, [DIST_ENTRY, ...args], {
      env: options.env ?? cleanEnv(),
      cwd: options.cwd,
      // stdin stays a pipe so we can write a quick EOF; 'ignore' would yield a
      // null stream and break the `.end(...)` calls below.
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (b: string) => (stdout += b));
    proc.stderr.on("data", (b: string) => (stderr += b));
    // Always close stdin so the CLI sees EOF immediately; some commands (REPL)
    // require it for graceful exit.
    proc.stdin.end(options.input ?? "");

    const timeoutMs = options.timeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`CLI timed out after ${timeoutMs}ms (args=${JSON.stringify(args)})`));
    }, timeoutMs);

    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveP({ code, stdout, stderr, signal, durationMs: Date.now() - t0 });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Run the CLI in an ephemeral, empty temp dir as cwd. This guarantees the
 * in-process dotenv loader cannot pick up the project's real .env, so
 * "no provider is ready" / "all providers fail" branches are reachable.
 * The temp dir is cleaned up before returning (success or failure).
 */
export async function runCliInEphemeralCwd(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string } = {},
): Promise<SpawnResult> {
  const dir = freshTempDir();
  try {
    return await runCli(args, { ...options, cwd: dir });
  } finally {
    removeDir(dir);
  }
}

/** Start the built entry point as a stdio MCP server, returning the live process. */
export function spawnServer(env: NodeJS.ProcessEnv = cleanEnv()): ChildProcess {
  return spawn(process.execPath, [DIST_ENTRY], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

/**
 * Minimal MCP stdio client: speaks the Content-Length framed JSON-RPC 2.0 the
 * SDK uses. Returns a `request` function; each call awaits one response by id.
 *
 * Intentionally lightweight — full MCP clients (e.g. @modelcontextprotocol/client)
 * can speak more capabilities (notifications, capabilities negotiation), but the
 * initialize/list/call round-trips needed for E2E only need request/response.
 */
export interface JsonRpcClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params?: unknown): void;
  close(): void;
  /** Resolves with whatever arrived on stderr, useful for ready-banner assertions. */
  stderr(): Promise<string>;
}

export function attachClient(proc: ChildProcess): JsonRpcClient {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  let buf = Buffer.alloc(0);
  proc.stdout!.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buf.slice(0, headerEnd).toString("ascii");
      const m = /^Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        // Drop everything up to headerEnd to recover from a malformed frame.
        buf = buf.slice(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const bodyStart = headerEnd + 4;
      if (buf.length < bodyStart + len) return; // wait for the rest of the body
      const body = buf.slice(bodyStart, bodyStart + len).toString("utf8");
      buf = buf.slice(bodyStart + len);
      let msg: { id?: number; method?: string; result?: unknown; error?: { message: string } };
      try {
        msg = JSON.parse(body);
      } catch {
        continue; // ignore malformed
      }
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        const slot = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) slot.reject(new Error(msg.error.message));
        else slot.resolve(msg.result);
      }
    }
  });

  let stderrText = "";
  proc.stderr!.setEncoding("utf8");
  proc.stderr!.on("data", (b: string) => (stderrText += b));

  function writeMessage(payload: Record<string, unknown>): void {
    const body = JSON.stringify(payload);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
    proc.stdin!.write(header);
    proc.stdin!.write(body);
  }

  function request<T>(method: string, params?: unknown): Promise<T> {
    const id = nextId++;
    return new Promise<T>((res, rej) => {
      pending.set(id, { resolve: (v) => res(v as T), reject: rej });
      writeMessage({ jsonrpc: "2.0", id, method, params });
    });
  }

  function notify(method: string, params?: unknown): void {
    writeMessage({ jsonrpc: "2.0", method, params });
  }

  function close(): void {
    if (!proc.killed) proc.kill();
  }

  const stderrPromise = new Promise<string>((res) => {
    proc.on("close", () => res(stderrText));
  });

  return { request, notify, close, stderr: () => stderrPromise };
}