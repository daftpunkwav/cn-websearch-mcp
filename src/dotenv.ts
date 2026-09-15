/**
 * @file dotenv
 * @description Minimal .env loader with zero runtime dependencies.
 *
 * Responsibilities:
 * - Read KEY=VALUE pairs from the .env file in a given directory (cwd by default)
 * - Strip matching surrounding quotes from values; skip comment lines and malformed lines
 * - Never overwrite existing process.env entries; silently skip when the file is missing
 */

// Minimal .env loader (no runtime dependencies). Existing process.env entries win.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Load KEY=VALUE pairs from the .env file in the given directory (cwd by
 * default). A missing file is normal. Values get no extra trimming, only
 * matching surrounding quotes are removed; existing environment variables
 * are never overwritten, so explicit MCP client configuration keeps
 * precedence. Uses Object.hasOwn instead of `in` for the existence check, so
 * prototype-chain property names (e.g. "toString") are not mistaken for
 * existing entries.
 */
export function loadDotEnv(dir: string = process.cwd(), into: NodeJS.ProcessEnv = process.env): void {
  let raw: string;
  try {
    raw = readFileSync(join(dir, ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!Object.hasOwn(into, key)) into[key] = value;
  }
}
