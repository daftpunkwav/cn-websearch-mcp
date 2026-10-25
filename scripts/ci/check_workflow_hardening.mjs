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
 * is text-based on purpose - the repository has no YAML parser in its toolchain,
 * and a workflow line is where these flags live.
 *
 * What the gate cannot see is tracked in issue #39: a URL that is assembled in
 * code, or a download client it does not know, is not a URL in the text of a
 * workflow.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_DIR = process.argv[2]
  ? resolve(process.argv[2])
  : join(REPO_ROOT, '.github', 'workflows');

// The npm commands that install packages or run dependency lifecycle scripts.
const INSTALL_COMMANDS = new Set([
  'ci', 'clean-install',
  'i', 'in', 'ins', 'inst', 'insta', 'instal', 'install', 'isnt', 'isnta', 'isntal',
  'cit', 'install-ci-test', 'install-test',
  'rebuild', 'update',
]);
// The npm commands that never install, so a name behind them is not an install.
const OTHER_COMMANDS = new Set([
  'run', 'run-script', 'exec', 'test', 'start', 'stop', 'restart', 'publish', 'pack',
  'init', 'uninstall', 'remove', 'rm',
]);
// The download clients the gate knows, by the name they run under.
const CURL_NAMES = new Set(['curl', 'curl.exe']);
const WGET_NAMES = new Set(['wget', 'wget.exe']);
// The only protocol list the policy accepts: HTTPS and nothing else.
const HTTPS_ONLY = '=https';

/**
 * The command with its comment removed: a '#' outside quotes starts one.
 */
function stripComment(text) {
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i);
  }
  return text;
}

/**
 * The arguments of a command: the quotes around a value are dropped.
 */
function argumentsOf(command) {
  const args = [];
  for (const raw of command.split(/\s+/)) {
    if (!raw) continue;
    args.push(raw.replace(/^["']/, '').replace(/["']$/, ''));
  }
  return args;
}

/**
 * The commands in a shell line: `a && b` runs two commands, and each one
 * has to carry its own protection.
 */
function splitCommands(text) {
  const parts = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ';' || char === '&' || char === '|') {
      if (current.trim()) parts.push(current.trim());
      current = '';
      if ((char === '&' || char === '|') && text[i + 1] === char) i += 1;
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * The lines of a workflow file with the folded scalars joined: a `run: >`
 * block is one command, while a literal `run: |` block keeps one command per
 * line.
 */
function foldScalars(lines) {
  const folded = [];
  let indent = null;
  for (const line of lines) {
    const width = line.text.length - line.text.trimStart().length;
    if (indent !== null) {
      if (line.text.trim() === '') {
        folded.push(line);
        continue;
      }
      if (width > indent) {
        const previous = folded[folded.length - 1];
        previous.text = `${previous.text} ${line.text.trim()}`;
        continue;
      }
      indent = null;
    }
    folded.push({ ...line });
    if (/^\s*(?:-\s*)?run:\s*>\s*$/.test(line.text)) indent = width;
  }
  return folded;
}

/**
 * The commands of a workflow file: a folded scalar is one command, a literal
 * block is one command per line, and a line that ends with a backslash
 * continues on the next one.
 */
function commandsOf(lines) {
  const commands = [];
  let buffer = null;
  let start = 0;

  const flush = () => {
    if (buffer === null) return;
    for (const part of splitCommands(buffer)) {
      const args = argumentsOf(part);
      if (args.length > 0) commands.push({ number: start, args });
    }
    buffer = null;
  };

  for (const line of foldScalars(lines)) {
    const text = stripComment(line.text);
    const continued = /\\\s*$/.test(text);
    const piece = continued ? text.replace(/\\\s*$/, '') : text;
    if (buffer === null) {
      buffer = piece;
      start = line.number;
    } else {
      buffer = `${buffer} ${piece.trim()}`;
    }
    if (!continued) flush();
  }
  flush();
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
      .map((text, index) => ({ text, number: index + 1 }));
    for (const command of commandsOf(lines)) {
      commands.push({ file, ...command });
    }
  }
  return commands;
}

/**
 * The name a command word runs under, without the path in front of it.
 *
 * @returns {string}
 */
function commandName(arg) {
  return arg.split(/[\\/]/).pop() ?? arg;
}

/**
 * The scheme of an argument that carries a URL, or an empty string when it
 * carries none.
 *
 * @returns {string}
 */
function urlScheme(arg) {
  const at = arg.indexOf('://');
  return at <= 0 ? '' : arg.slice(0, at).toLowerCase();
}

/**
 * The value of the last occurrence of an option, in either the
 * `--option value` or the `--option=value` spelling. The last occurrence
 * wins, because that is how the client reads it. An option that is not
 * there reads as an empty value.
 *
 * @returns {string}
 */
function optionValue(args, name) {
  let value = '';
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === name) {
      value = args[i + 1] ?? '';
      i += 1;
    } else if (arg.startsWith(`${name}=`)) {
      value = arg.slice(name.length + 1);
    }
  }
  return value;
}

/**
 * Whether a boolean flag is set. The last occurrence decides, so
 * `--ignore-scripts=false` and `--no-ignore-scripts` switch it off again.
 *
 * @returns {boolean}
 */
function flagEnabled(args, name) {
  const negated = `--no-${name.slice(2)}`;
  let enabled = false;
  for (const arg of args) {
    if (arg === name) enabled = true;
    else if (arg === negated) enabled = false;
    else if (arg.startsWith(`${name}=`)) enabled = arg.slice(name.length + 1) !== 'false';
  }
  return enabled;
}

/** Whether the command asks the client to follow redirects. */
function followsRedirects(args) {
  return args.some((arg) => (
    arg === '--location'
    || arg === '--location-trusted'
    || arg.startsWith('--location-trusted=')
    || (/^-[A-Za-z]+$/.test(arg) && arg.includes('L'))
  ));
}

/**
 * Whether the command installs packages. The verb can sit behind npm's
 * global options (`npm --prefix ./app ci`), while a name behind `npm run` is
 * a script and not an install.
 */
function isInstall(args) {
  const npmAt = args.indexOf('npm');
  if (npmAt === -1) return false;
  for (let i = npmAt + 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('-')) continue;
    if (OTHER_COMMANDS.has(arg)) return false;
    if (arg.includes('/')) continue;
    if (INSTALL_COMMANDS.has(arg)) return true;
  }
  return false;
}

/** The transfers of a curl command: `--next` starts a new one. */
function transfers(args) {
  const parts = [[]];
  for (const arg of args) {
    if (arg === '--next') parts.push([]);
    else parts[parts.length - 1].push(arg);
  }
  return parts;
}

/** The violation of a cleartext URL, or null when every URL is HTTPS. */
function cleartextViolation(args) {
  for (const arg of args) {
    const scheme = urlScheme(arg);
    if (scheme && scheme !== 'https') {
      return `download over a protocol other than HTTPS (${arg})`;
    }
  }
  return null;
}

/** The violation of a package install, or null when it keeps its protection. */
function installViolation(args) {
  if (!isInstall(args)) return null;
  if (flagEnabled(args, '--ignore-scripts')) return null;
  return 'package install without --ignore-scripts';
}

/** Whether the command asks for TLS 1.2 or later. */
function pinsTls(args) {
  return args.some((arg) => (
    arg === '--tlsv1.2' || arg === '--tlsv1.3' || arg.startsWith('--tls-max')
  ));
}

/** The violation of one curl transfer, or null when it keeps its protections. */
function curlTransferViolation(args) {
  if (optionValue(args, '--proto') !== HTTPS_ONLY) return "curl without --proto '=https'";
  if (optionValue(args, '--config') !== '' || args.includes('-K')) {
    return 'curl reads its options from a file the gate cannot check';
  }
  if (!pinsTls(args)) return 'curl without --tlsv1.2';
  if (followsRedirects(args) && optionValue(args, '--proto-redir') !== HTTPS_ONLY) {
    return "curl follows redirects without --proto-redir '=https'";
  }
  return null;
}

/** The violation of a curl command, or null when it keeps its protections. */
function curlViolation(args) {
  for (const transfer of transfers(args)) {
    const violation = curlTransferViolation(transfer);
    if (violation) return violation;
  }
  return null;
}

/** The violation of a wget command, or null when it keeps its protection. */
function wgetViolation(args) {
  if (optionValue(args, '--max-redirect') !== '0') {
    return 'wget may follow redirects (--max-redirect=0 required)';
  }
  if (args.some((arg) => arg.startsWith('--input-file'))) {
    return 'wget reads its URLs from a file the gate cannot check';
  }
  if (!args.some((arg) => urlScheme(arg) !== '')) {
    return 'wget without a URL the gate cannot check';
  }
  return null;
}

/** The violation of a download, or null when it keeps its protections. */
function downloadViolation(args) {
  if (args.some((arg) => CURL_NAMES.has(commandName(arg)))) return curlViolation(args);
  if (args.some((arg) => WGET_NAMES.has(commandName(arg)))) return wgetViolation(args);
  return null;
}

/**
 * The violation a command carries, or null when it keeps every protection.
 */
function violationOf(args) {
  return cleartextViolation(args)
    ?? installViolation(args)
    ?? downloadViolation(args);
}

const violations = [];
let checked = 0;

for (const command of workflowCommands()) {
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
