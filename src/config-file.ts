/**
 * @file config-file
 * @description Locating and reading the JSON config file (I/O and syntax only; no semantic validation).
 *
 * Responsibilities:
 * - Locate the config file: explicit WEBSEARCH_CONFIG wins, otherwise the conventional file under cwd
 * - Read and parse JSON; any failure (missing, unreadable, invalid JSON, non-object) only warns and returns undefined
 * - Define the config file's field shape (loose types; semantic validation is the config module's job)
 */

// Config file I/O layer. Deliberately dumb: it only turns on-disk JSON into
// an object; field semantics and value validity are config.ts's job, so the
// two layers can be tested independently.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Conventional file name looked up in the current working directory when no explicit path is set. */
export const CONFIG_FILENAME = "cn-websearch.config.json";

/**
 * Raw shape of the config file. Every field is unknown: the entry point is
 * loose and each field is validated individually, so one typo doesn't get
 * the whole config rejected.
 */
export interface ConfigFileShape {
  strategy?: unknown;
  order?: unknown;
  count?: unknown;
  timeoutMs?: unknown;
  maxProviders?: unknown;
  dedupe?: unknown;
  providers?: unknown;
}

/** Injection point for reading a text file (defaults to a synchronous UTF-8 read). */
export type ReadFileFn = (path: string) => string;

/** Injection point for file-existence checks (defaults to fs.existsSync). */
export type FileExistsFn = (path: string) => boolean;

/**
 * Locate the config file path:
 * - When WEBSEARCH_CONFIG is set, it wins (returned even if the file doesn't exist; the read layer warns)
 * - Otherwise `cn-websearch.config.json` under cwd, returned only when the file actually exists
 * - Neither → undefined (pure environment-variable mode)
 */
export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  fileExists: FileExistsFn = existsSync,
): string | undefined {
  const explicit = (env.WEBSEARCH_CONFIG ?? "").trim();
  if (explicit) return explicit;
  const conventional = join(cwd, CONFIG_FILENAME);
  return fileExists(conventional) ? conventional : undefined;
}

/**
 * Read and parse the config file. Nothing throws: missing, unreadable,
 * invalid JSON, or a non-object top level all warn and return undefined,
 * letting the gateway keep running on defaults / environment variables.
 */
export function readConfigFile(
  path: string,
  warn: (m: string) => void,
  readFile: ReadFileFn = (p) => readFileSync(p, "utf8"),
): ConfigFileShape | undefined {
  let raw: string;
  try {
    raw = readFile(path);
  } catch (err) {
    warn(`config file not readable (${path}): ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warn(`config file is not valid JSON (${path}): ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warn(`config file must contain a JSON object (${path})`);
    return undefined;
  }
  return parsed as ConfigFileShape;
}
