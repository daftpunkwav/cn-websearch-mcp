/**
 * @file workflow/install_policy
 * @description Decide whether a package install keeps its protection.
 *
 * Responsibilities:
 * - Recognize the npm commands that install packages or run dependency
 *   lifecycle scripts, including the aliases
 * - Recognize the npm commands that never install, so a name behind them is
 *   not an install
 * - Report an install that does not carry `--ignore-scripts`
 *
 * Constraints:
 * - The verb can sit behind npm's global options (`npm --prefix ./app ci`),
 *   while a name behind `npm run` is a script and not an install.
 */

import { commandName, flagEnabled } from './command_options.mjs';

// The npm commands that install packages or run dependency lifecycle scripts,
// with the aliases npm resolves them from (npm/lib/utils/cmd-list.js).
const INSTALL_COMMANDS = new Set([
  'ci', 'clean-install', 'ic', 'install-clean', 'isntall-clean',
  'i', 'in', 'ins', 'inst', 'insta', 'instal', 'install', 'isnt', 'isnta', 'isntal', 'isntall',
  'add',
  'cit', 'install-ci-test', 'clean-install-test', 'sit',
  'install-test', 'it',
  'rebuild', 'rb',
  'update', 'u', 'up', 'upgrade', 'udpate',
  'dedupe', 'ddp',
  'link', 'ln',
]);
// The npm commands that never install, so a name behind them is not an install.
const OTHER_COMMANDS = new Set([
  'run', 'run-script', 'exec', 'test', 'start', 'stop', 'restart', 'publish', 'pack',
  'init', 'uninstall', 'remove', 'rm',
]);
// The names the npm command runs under, with the path in front of it left off.
const NPM_NAMES = new Set(['npm', 'npm.cmd']);

/** Whether the argument is an option or a path, and not the verb itself. */
function isNotTheVerb(arg) {
  return arg.startsWith('-') || arg.includes('/');
}

/**
 * The install verb of an npm invocation, or null when the invocation does
 * not install.
 */
function installVerb(args) {
  for (const arg of args) {
    if (isNotTheVerb(arg)) continue;
    if (OTHER_COMMANDS.has(arg)) return null;
    if (INSTALL_COMMANDS.has(arg)) return arg;
  }
  return null;
}

/**
 * Whether the command installs packages. The verb can sit behind npm's
 * global options (`npm --prefix ./app ci`), while a name behind `npm run` is
 * a script and not an install. The npm command itself can carry a path in
 * front of it (`/usr/local/bin/npm ci`).
 */
export function isInstall(args) {
  const npmAt = args.findIndex((arg) => NPM_NAMES.has(commandName(arg)));
  if (npmAt === -1) return false;
  return installVerb(args.slice(npmAt + 1)) !== null;
}

/** The violation of a package install, or null when it keeps its protection. */
export function installViolation(args) {
  if (!isInstall(args)) return null;
  if (flagEnabled(args, '--ignore-scripts')) return null;
  return 'package install without --ignore-scripts';
}
