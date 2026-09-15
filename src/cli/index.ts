/**
 * @file cli/index
 * @description CLI dispatch entry point: routes commands to serve or the one-shot commands, and unifies exit codes.
 *
 * Responsibilities:
 * - Parse argv and dispatch to serve / search / status / test / repl / help / version
 * - With no arguments, start the MCP stdio server (preserving how MCP clients already launch it)
 * - Collapse all failures into exit codes; never throws from this layer
 */

// CLI dispatch layer. All dependencies (runtime, output streams, the serve implementation) are
// injected by the caller, so it can be driven entirely in tests without spawning a subprocess.

import { SERVER_NAME, SERVER_VERSION } from "../server-info.js";
import { parseArgs, usage } from "./args.js";
import { cmdSearch, cmdStatus, cmdTest, type CliDeps } from "./commands.js";
import { runRepl } from "./repl.js";

/** Exit codes: 0 success, 1 runtime failure, 2 usage error. */
export const EXIT = { ok: 0, failure: 1, usage: 2 } as const;

/** CLI dependencies: CliDeps plus the serve implementation (injected by the entry point). */
export interface CliRunDeps extends CliDeps {
  serve: () => Promise<void>;
  input: NodeJS.ReadableStream;
}

function write(stream: NodeJS.WritableStream, text: string): void {
  stream.write(text.endsWith("\n") ? text : text + "\n");
}

/**
 * Run one CLI invocation and return the exit code. This is the only CLI entry point:
 * index.ts merely injects the real dependencies and converts the exit code into a process exit.
 */
export async function runCli(argv: string[], deps: CliRunDeps): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    write(deps.error, `error: ${parsed.message}`);
    write(deps.error, usage());
    return EXIT.usage;
  }
  const args = parsed.args;

  switch (args.command) {
    case "help":
      write(deps.output, usage());
      return EXIT.ok;

    case "version":
      write(deps.output, `${SERVER_NAME} ${SERVER_VERSION}`);
      return EXIT.ok;

    case "status":
      return await cmdStatus(deps, args);

    case "search":
      return await cmdSearch(deps, args);

    case "test":
      return await cmdTest(deps, args);

    case "repl":
      return await runRepl(deps, deps);

    case "serve":
    default:
      try {
        await deps.serve();
        return EXIT.ok;
      } catch (err) {
        write(deps.error, `[${SERVER_NAME}] fatal: ${err instanceof Error ? err.message : String(err)}`);
        return EXIT.failure;
      }
  }
}
