/**
 * @file cli/args
 * @description Command-line argument parsing and help text.
 *
 * Responsibilities:
 * - Parse argv into structured commands (serve / search / status / test / repl / help / version)
 * - Support both --flag value and --flag=value forms; return readable errors on invalid input
 * - Provide usage text; never reads config or touches the network
 */

// CLI argument layer. Pure functions: input is the argv array, output is a structured command or an error message.

import type { SearchStrategy } from "../types.js";

/** Supported command names (including aliases). */
const COMMAND_ALIASES: Record<string, CliCommandName> = {
  serve: "serve",
  mcp: "serve",
  search: "search",
  status: "status",
  test: "test",
  repl: "repl",
  shell: "repl",
  interactive: "repl",
  help: "help",
  version: "version",
};

export type CliCommandName = "serve" | "search" | "status" | "test" | "repl" | "help" | "version";

export interface CliArgs {
  command: CliCommandName;
  /** Query text for search/test (required for search; optional for test, defaults to the built-in probe query). */
  query: string;
  count?: number;
  strategy?: SearchStrategy;
  providers?: string[];
  /** Overrides the dedupe switch from config (used by the aggregate strategy). */
  dedupe?: boolean;
  /** Output raw JSON (easy for scripts to consume). */
  json: boolean;
}

export type ParseResult = { ok: true; args: CliArgs } | { ok: false; message: string };

const STRATEGIES: readonly SearchStrategy[] = ["fallback", "aggregate"];

export function usage(): string {
  return [
    "cn-websearch-mcp - multi-channel web search over OpenAI-compatible chat-completions and standalone search REST APIs",
    "",
    "Usage:",
    "  cn-websearch-mcp                        Start the MCP server on stdio (default; use this in MCP clients)",
    "  cn-websearch-mcp serve                  Same as above",
    "  cn-websearch-mcp search <query...>      One-shot search and print results",
    "  cn-websearch-mcp status                 Show effective settings and provider status",
    "  cn-websearch-mcp test [provider...]     Probe each provider once (connectivity/latency check)",
    "  cn-websearch-mcp repl                   Interactive terminal session",
    "  cn-websearch-mcp help                   Show this help",
    "  cn-websearch-mcp version                Show version",
    "",
    "Options:",
    "  -n, --count <1-50>         Desired number of results",
    "      --strategy <s>         fallback | aggregate (multi-source merge)",
    "      --providers <a,b>      Restrict this call to the given providers",
    "      --no-dedupe            Keep duplicate URLs when aggregating",
    "  -q, --query <text>         Query for `test` (default: a generic probe query)",
    "      --json                 Print raw JSON instead of formatted text",
    "  -h, --help                 Show this help",
    "  -v, --version              Show version",
    "",
    "Examples:",
    "  cn-websearch-mcp search 最近一周国内发布的大模型",
    "  cn-websearch-mcp search --strategy aggregate --count 12 \"rust async runtime\"",
    "  cn-websearch-mcp test stepfun zhipu",
    "  WEBSEARCH_STRATEGY=aggregate cn-websearch-mcp search hello",
  ].join("\n");
}

/** Parses a positive-integer option; returns undefined when invalid. */
function parsePositiveInt(raw: string): number | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Parse argv.
 * - Empty arguments mean serve (MCP clients launch this process with no args; this default must be preserved)
 * - Bare words (tokens not starting with `-`) are consumed in order: the first resolves the command, the rest join into the query
 * - Unknown commands/options/missing values always return an error message (instead of guessing intent)
 */
export function parseArgs(argv: string[]): ParseResult {
  const args: CliArgs = { command: "serve", query: "", json: false };
  const words: string[] = [];
  let commandSet = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === "-h" || token === "--help") {
      args.command = "help";
      return { ok: true, args };
    }
    if (token === "-v" || token === "--version") {
      args.command = "version";
      return { ok: true, args };
    }

    // Support both --opt=value and --opt value forms.
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = eq > 0 ? token.slice(0, eq) : token;
    const inlineValue = eq > 0 ? token.slice(eq + 1) : undefined;
    const takeValue = (): string | undefined => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) return undefined;
      i++;
      return next;
    };

    if (flag === "--json") {
      args.json = true;
      continue;
    }
    if (flag === "--no-dedupe") {
      args.dedupe = false;
      continue;
    }
    if (flag === "-n" || flag === "--count") {
      const value = takeValue();
      const n = value === undefined ? undefined : parsePositiveInt(value);
      if (n === undefined) return { ok: false, message: `invalid --count value: ${value ?? "(missing)"}` };
      args.count = n;
      continue;
    }
    if (flag === "-q" || flag === "--query") {
      const value = takeValue();
      if (value === undefined) return { ok: false, message: "missing value for --query" };
      args.query = value;
      continue;
    }
    if (flag === "--strategy") {
      const value = (takeValue() ?? "").toLowerCase() as SearchStrategy;
      if (!(STRATEGIES as readonly string[]).includes(value)) {
        return { ok: false, message: `invalid --strategy value: ${value || "(missing)"} (expected fallback|aggregate)` };
      }
      args.strategy = value;
      continue;
    }
    if (flag === "--providers") {
      const value = takeValue();
      if (value === undefined) return { ok: false, message: "missing value for --providers" };
      const list = value.split(",").map((s) => s.trim()).filter((s) => s !== "");
      if (!list.length) return { ok: false, message: "invalid --providers value: expected a comma-separated list" };
      args.providers = list;
      continue;
    }
    if (token.startsWith("-")) {
      return { ok: false, message: `unknown option: ${token}` };
    }

    // Bare words: the first picks the command, the rest become the query.
    if (!commandSet) {
      const command = COMMAND_ALIASES[token.toLowerCase()];
      if (command) {
        args.command = command;
        commandSet = true;
        continue;
      }
      return { ok: false, message: `unknown command: ${token} (try \`search ${token}\` or --help)` };
    }
    words.push(token);
  }

  const joined = words.join(" ").trim();
  if (joined) args.query = args.query ? `${args.query} ${joined}`.trim() : joined;
  return { ok: true, args };
}
