/**
 * @file dotenv
 * @description Minimal .env loader with zero runtime dependencies.
 *
 * Responsibilities:
 * - Read KEY=VALUE pairs from the .env file in a given directory (cwd by default)
 * - Strip matching surrounding quotes from values; skip comment lines and malformed lines
 * - Only export the names the gateway actually reads, so a .env cannot reach the
 *   variables the Node runtime itself acts on
 * - Never overwrite existing process.env entries; silently skip when the file is missing
 */

// Minimal .env loader (no runtime dependencies). Existing process.env entries win.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_PROVIDERS } from "./config.js";
import { SERVER_NAME } from "./server-info.js";

/**
 * Gateway-wide variables, mirroring the WEBSEARCH_* names config.ts reads plus
 * the legacy ZHIPU_SEARCH_ENGINE knob.
 */
const GATEWAY_KEYS: ReadonlySet<string> = new Set([
  "WEBSEARCH_CONFIG",
  "WEBSEARCH_COUNT",
  "WEBSEARCH_DEDUPE",
  "WEBSEARCH_MAX_PROVIDERS",
  "WEBSEARCH_ORDER",
  "WEBSEARCH_STRATEGY",
  "WEBSEARCH_TIMEOUT_MS",
  "ZHIPU_SEARCH_ENGINE",
]);

/** Per-slot suffixes, mirroring the suffixes providerEnvKey() builds in config.ts. */
const SLOT_SUFFIXES: readonly string[] = ["API_KEY", "BASE_URL", "ENABLED", "MODEL", "PRIORITY", "TIMEOUT_MS"];

/**
 * Names that look like a gateway setting without being one. Only these earn a
 * warning when they are skipped: a user who wrote SOMEVENDOR_API_KEY needs to
 * know it was ignored, one who put an unrelated name in their .env does not.
 */
const GATEWAY_LIKE = /(?:^WEBSEARCH_|_(?:API_KEY|BASE_URL|MODEL|ENABLED|PRIORITY|TIMEOUT_MS|SEARCH_ENGINE)$)/;

/**
 * Whether `key` names a setting this program actually reads.
 *
 * A .env file is data from the working directory, and the working directory is
 * not necessarily trusted: any repository can ship one. Writing every name it
 * contains into process.env would let such a file set NODE_OPTIONS or
 * LD_PRELOAD, which the runtime acts on before this program's first request —
 * turning "start the MCP server in this folder" into running someone else's
 * code. Only configuration the gateway resolves may cross that boundary.
 */
export function isGatewayEnvKey(key: string): boolean {
  if (GATEWAY_KEYS.has(key)) return true;
  const cut = key.indexOf("_");
  const slot = cut > 0 ? key.slice(0, cut).toLowerCase() : "";
  const suffix = cut > 0 ? key.slice(cut + 1) : key;
  return (KNOWN_PROVIDERS as readonly string[]).includes(slot) && SLOT_SUFFIXES.includes(suffix);
}

/**
 * Load KEY=VALUE pairs from the .env file in the given directory (cwd by
 * default). A missing file is normal. Values get no extra trimming, only
 * matching surrounding quotes are removed; existing environment variables
 * are never overwritten, so explicit MCP client configuration keeps
 * precedence. Uses Object.hasOwn instead of `in` for the existence check, so
 * prototype-chain property names (e.g. "toString") are not mistaken for
 * existing entries.
 *
 * Names the gateway does not read are skipped: see isGatewayEnvKey for why an
 * arbitrary .env must not become process.env. A skipped name that looks like a
 * gateway setting is reported through `warn`, so a typo is visible instead of
 * silently doing nothing.
 */
export function loadDotEnv(
  dir: string = process.cwd(),
  into: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (m) => console.error(`[${SERVER_NAME}] ${m}`),
): void {
  let raw: string;
  try {
    raw = readFileSync(join(dir, ".env"), "utf8");
  } catch {
    return;
  }
  // Editors on Windows commonly save with a UTF-8 BOM; without stripping it the
  // first key would silently carry an invisible prefix and never match env lookups.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
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
    if (!isGatewayEnvKey(key)) {
      if (GATEWAY_LIKE.test(key)) warn(`ignoring unknown setting "${key}" in .env`);
      continue;
    }
    if (!Object.hasOwn(into, key)) into[key] = value;
  }
}
