#!/usr/bin/env node
/**
 * Workflow hardening check: fail when a workflow step drops a protection.
 *
 * Responsibilities:
 * - Fail when a package install in a workflow runs dependency lifecycle scripts
 * - Fail when a download in a workflow uses another protocol than HTTPS, or
 *   follows a redirect that may leave HTTPS
 * - Read the workflow directory only: no install and no network required
 *
 * Usage: `node scripts/ci/check_workflow_hardening.mjs [workflow-dir]`
 *
 * Why: both protections are one edit away from being dropped by a later edit,
 * and nothing else in the build would notice that they were gone. The check
 * is text-based on purpose - the repository has no YAML parser in its
 * toolchain, and a workflow line is where these flags live.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_DIR = process.argv[2]
  ? resolve(process.argv[2])
  : join(REPO_ROOT, '.github', 'workflows');

// Package installs, including the npm aliases: ci, install, i, add.
const NPM_INSTALL = /\bnpm\s+(?:ci|install|i|add)(?![\w-])/;
// A download client as a command word.
const CURL = /^curl(\.exe)?$/;
const WGET = /^wget(\.exe)?$/;
// A URL argument, whatever its scheme.
const URL = /^[a-z][a-z0-9+.-]*:\/\//i;
// The only protocol list the policy accepts: HTTPS and nothing else.
const HTTPS_ONLY = '=https';

/**
 * The arguments of a command: the quotes around a value are dropped, and
 * everything from a '#' on is a comment.
 */
function argumentsOf(command) {
  const args = [];
  for (const raw of command.split(/\s+/)) {
    if (!raw) continue;
    const arg = raw.replace(/^["']/, '').replace(/["']$/, '');
    if (arg.startsWith('#')) break;
    args.push(arg);
  }
  return args;
}

/**
 * The value of the last occurrence of an option, in either the
 * `--option value` or the `--option=value` spelling. The last occurrence
 * wins, because that is how the client reads it.
 */
function optionValue(args, name) {
  let value;
  args.forEach((arg, index) => {
    if (arg === name) value = args[index + 1];
    else if (arg.startsWith(`${name}=`)) value = arg.slice(name.length + 1);
  });
  return value;
}

/**
 * Whether a boolean flag is set. The last occurrence decides, so
 * `--ignore-scripts=false` switches it off again.
 */
function flagEnabled(args, name) {
  let enabled;
  args.forEach((arg) => {
    if (arg === name) enabled = true;
    else if (arg.startsWith(`${name}=`)) enabled = arg.slice(name.length + 1) !== 'false';
  });
  return enabled;
}

/** Whether the command asks the client to follow redirects. */
function followsRedirects(args) {
  return args.some((arg) => arg === '--location' || (/^-[A-Za-z]+$/.test(arg) && arg.includes('L')));
}

/**
 * The violation a command carries, or null when it keeps every protection.
 */
function violationOf(args) {
  const isCurl = args.some((arg) => CURL.test(arg));
  const isWget = args.some((arg) => WGET.test(arg));

  if (NPM_INSTALL.test(args.join(' ')) && flagEnabled(args, '--ignore-scripts') !== true) {
    return 'package install without --ignore-scripts';
  }
  if (!isCurl && !isWget) return null;

  const cleartext = args.find((arg) => URL.test(arg) && !arg.toLowerCase().startsWith('https://'));
  if (cleartext) return `download over a protocol other than HTTPS (${cleartext})`;
  if (isCurl && optionValue(args, '--proto') !== HTTPS_ONLY) {
    return "curl without --proto '=https'";
  }
  if (isCurl && followsRedirects(args) && optionValue(args, '--proto-redir') !== HTTPS_ONLY) {
    return "curl follows redirects without --proto-redir '=https'";
  }
  if (isWget && optionValue(args, '--max-redirect') !== '0') {
    return 'wget may follow redirects (--max-redirect=0 required)';
  }
  return null;
}

/**
 * The commands of a workflow file: a line that ends with a backslash
 * continues on the next one, and the flags of such a command belong
 * together.
 */
function commandsOf(lines) {
  const commands = [];
  let current = [];
  let start = 0;
  lines.forEach((line, index) => {
    const continued = line.text.endsWith('\\');
    current.push(continued ? line.text.slice(0, -1) : line.text);
    if (current.length === 1) start = index + 1;
    if (!continued) {
      commands.push({ number: start, args: argumentsOf(current.join(' ')) });
      current = [];
    }
  });
  if (current.length > 0) commands.push({ number: start, args: argumentsOf(current.join(' ')) });
  return commands;
}

/** Every command of every workflow file, with its file name and line number. */
function workflowCommands() {
  const files = readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
  const commands = [];
  for (const file of files) {
    const lines = readFileSync(join(WORKFLOW_DIR, file), 'utf8')
      .split('\n')
      .map((text) => ({ text }));
    for (const command of commandsOf(lines)) {
      commands.push({ file, ...command });
    }
  }
  return commands;
}

const violations = [];
let checked = 0;

for (const command of workflowCommands()) {
  if (command.args.length === 0) continue;
  checked += 1;
  const violation = violationOf(command.args);
  if (violation) violations.push(`${command.file}:${command.number}: ${violation}`);
}

if (violations.length > 0) {
  console.error('workflow hardening violated:');
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error('restore the protection or change this checker on purpose');
  process.exit(1);
}

console.log(`workflow hardening ok (${checked} commands checked)`);
