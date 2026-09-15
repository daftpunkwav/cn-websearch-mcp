/**
 * @file cli/repl
 * @description Interactive terminal session: type a query to search; slash commands control the system.
 *
 * Responsibilities:
 * - Provide a readline session: bare text is treated as a search, `/commands` control strategy/count/providers
 * - Process input lines serially so concurrent searches do not interleave output
 * - Any single command failure only prints the error and continues; the session is never ended by it
 */

// Interactive session layer. Session state (strategy/count/provider filter/output format) lives only
// in memory and is never written back to the config file — the CLI is a consumer, not a configuration tool.

import { createInterface } from "node:readline";
import { KNOWN_PROVIDERS } from "../config.js";
import type { SearchStrategy } from "../types.js";
import { redactedConfig } from "./render.js";
import { cmdSearch, cmdStatus, cmdTest, DEFAULT_PROBE_QUERY, type CliDeps } from "./commands.js";
import type { CliArgs } from "./args.js";

const PROMPT = "cn-websearch> ";
const STRATEGIES: readonly SearchStrategy[] = ["fallback", "aggregate"];

/** Mutable in-session state. */
export interface ReplSession {
  strategy: SearchStrategy;
  count: number;
  providers?: string[];
  dedupe: boolean;
  json: boolean;
}

const HELP = [
  "Commands (any other input is treated as a search query):",
  "  /search <query>          Search with the current settings",
  "  /aggregate <query>       Search several providers at once and merge the results",
  "  /strategy [name]         Show or set strategy: fallback | aggregate",
  "  /count [n]               Show or set the desired number of results",
  "  /providers [a,b]         Show or set the provider subset for this session",
  "  /status                  Show effective settings and provider status",
  "  /test [provider...]      Probe providers once (real requests)",
  "  /config                  Show the redacted effective configuration",
  "  /json [on|off]           Toggle raw JSON output",
  "  /help                    Show this help",
  "  /quit                    Exit (also: /exit, /q, Ctrl-D)",
].join("\n");

/** Whether the line is a slash command rather than a bare-text search. */
function looksLikeCommand(line: string): boolean {
  return line.startsWith("/");
}

/**
 * Run the interactive session. Returns the exit code (always 0 on normal exit).
 * All input/output goes through the injected io, so tests can substitute streams for a real terminal.
 */
export async function runRepl(deps: CliDeps, io: { input: NodeJS.ReadableStream }): Promise<number> {
  const config = deps.runtime.config;
  const session: ReplSession = {
    strategy: config.strategy,
    count: config.count,
    dedupe: config.dedupe,
    json: false,
  };
  const chainNames = deps.runtime.chain.map((p) => p.name);

  const rl = createInterface({ input: io.input as NodeJS.ReadableStream & { isTTY?: boolean }, output: deps.output as NodeJS.WritableStream });
  const write = (text: string): void => {
    deps.output.write(text.endsWith("\n") ? text : text + "\n");
  };
  write(`cn-websearch-mcp interactive session — ${chainNames.length} provider(s) ready: ${chainNames.join(", ") || "(none)"}`);
  write("Type a query to search, or /help for commands.");

  /** Delegate one search to the one-shot command to reuse the same validation and error handling. */
  const doSearch = async (query: string): Promise<void> => {
    if (!query.trim()) {
      write("usage: /search <query>");
      return;
    }
    // In-session switches are slash commands; if a user passes a --flag as the query, silently
    // searching a "--" query would be misleading, so offer a workable alternative instead.
    if (query.startsWith("-")) {
      write("error: /search takes a query only — use /json, /count, /strategy or /providers to change session settings");
      return;
    }
    const args: CliArgs = {
      command: "search",
      query,
      count: session.count,
      strategy: session.strategy,
      providers: session.providers,
      dedupe: session.dedupe,
      json: session.json,
    };
    await cmdSearch(deps, args);
  };

  /** Handle one line of input; the return value indicates whether exit was requested. */
  const handle = async (line: string): Promise<boolean> => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (!looksLikeCommand(trimmed)) {
      await doSearch(trimmed);
      return false;
    }

    const [rawCmd, ...rest] = trimmed.slice(1).split(/\s+/);
    const cmd = (rawCmd ?? "").toLowerCase();
    const argText = rest.join(" ").trim();

    switch (cmd) {
      case "quit":
      case "exit":
      case "q":
        return true;

      case "help":
      case "?":
        write(HELP);
        return false;

      case "search":
      case "aggregate": {
        // /aggregate is a one-shot multi-source search; it does not change the session default strategy.
        const args: CliArgs = {
          command: "search",
          query: argText,
          count: session.count,
          strategy: cmd === "aggregate" ? "aggregate" : session.strategy,
          providers: session.providers,
          dedupe: session.dedupe,
          json: session.json,
        };
        if (!args.query) {
          write(`usage: /${cmd} <query>`);
          return false;
        }
        if (args.query.startsWith("-")) {
          write(`error: /${cmd} takes a query only — use /json, /count, /strategy or /providers for session settings`);
          return false;
        }
        await cmdSearch(deps, args);
        return false;
      }

      case "strategy": {
        if (!argText) {
          write(`strategy: ${session.strategy}`);
          return false;
        }
        const value = argText.toLowerCase() as SearchStrategy;
        if (!(STRATEGIES as readonly string[]).includes(value)) {
          write(`error: unknown strategy "${argText}" (expected ${STRATEGIES.join("|")})`);
          return false;
        }
        session.strategy = value;
        write(`strategy: ${value}`);
        return false;
      }

      case "count": {
        if (!argText) {
          write(`count: ${session.count}`);
          return false;
        }
        const n = Number(argText);
        if (!Number.isInteger(n) || n <= 0) {
          write(`error: invalid count "${argText}" (expected a positive integer)`);
          return false;
        }
        session.count = n;
        write(`count: ${n}`);
        return false;
      }

      case "providers": {
        if (!argText) {
          write(`providers: ${session.providers?.join(", ") ?? "(all available)"}`);
          return false;
        }
        if (argText === "all" || argText === "-") {
          session.providers = undefined;
          write("providers: (all available)");
          return false;
        }
        const list = argText.split(",").map((s) => s.trim()).filter((s) => s !== "");
        const unknown = list.filter((n) => !(KNOWN_PROVIDERS as readonly string[]).includes(n));
        if (unknown.length) {
          write(`error: unknown provider(s): ${unknown.join(", ")} (known: ${KNOWN_PROVIDERS.join(", ")})`);
          return false;
        }
        session.providers = list;
        write(`providers: ${list.join(", ")}`);
        return false;
      }

      case "status":
        await cmdStatus(deps, { command: "status", query: "", json: session.json });
        return false;

      case "test":
        await cmdTest(deps, {
          command: "test",
          query: argText || DEFAULT_PROBE_QUERY,
          providers: argText ? argText.split(/\s+/).filter((s) => s !== "") : session.providers,
          json: session.json,
        });
        return false;

      case "config":
        write(JSON.stringify(redactedConfig(config), null, 2));
        return false;

      case "json": {
        if (!argText) {
          write(`json: ${session.json ? "on" : "off"}`);
          return false;
        }
        const value = argText.toLowerCase();
        if (value !== "on" && value !== "off") {
          write(`error: expected /json on or /json off`);
          return false;
        }
        session.json = value === "on";
        write(`json: ${value}`);
        return false;
      }

      default:
        write(`unknown command: /${cmd} — type /help for the list`);
        return false;
    }
  };

  // Serial queue: input lines can arrive faster than async searches; chaining awaits prevents interleaved output.
  let pending: Promise<void> = Promise.resolve();
  let quit = false;
  rl.on("line", (raw) => {
    if (quit) return;
    pending = pending.then(async () => {
      if (quit) return;
      try {
        const shouldQuit = await handle(raw);
        if (shouldQuit) {
          quit = true;
          rl.close();
          return;
        }
      } catch (err) {
        // An unexpected failure in a single command must not end the session.
        write(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
      rl.prompt();
    });
  });

  rl.on("SIGINT", () => {
    write("");
    quit = true;
    rl.close();
  });

  return await new Promise<number>((resolve) => {
    rl.on("close", () => {
      void pending.then(() => resolve(0));
    });
    rl.prompt();
  });
}
