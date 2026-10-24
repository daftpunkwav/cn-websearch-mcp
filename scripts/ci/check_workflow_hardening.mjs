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
const URL_TOKEN = /^[a-z][a-z0-9+.-]*:\/\//i;
// The only protocol list the policy accepts: HTTPS and nothing else.
const HTTPS_ONLY = '=https';

/**
 * Cut a line at its comment, so a flag that only appears in a comment does
 * not count as set. A '#' starts a comment when it is outside quotes and
 * either starts the line or follows whitespace.
 */
function stripComment(line) {
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/**
 * Split a command into tokens, keeping a quoted argument together and
 * dropping the quotes: `--proto '=https'` is two tokens, the option and its
 * value.
 */
function tokenize(command) {
  const tokens = [];
  let current = '';
  let quote = '';
  for (const char of command) {
    if (quote) {
      if (char === quote) {
        quote = '';
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * The value of the last occurrence of an option, in either the
 * `--option value` or the `--option=value` spelling. The last occurrence
 * wins, because that is how the client reads it.
 */
function lastOptionValue(tokens, name) {
  let value;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === name) {
      value = tokens[i + 1];
      i += 1;
    } else if (token.startsWith(`${name}=`)) {
      value = token.slice(name.length + 1);
    }
  }
  return value;
}

/**
 * The state of a boolean flag: undefined when it is absent, otherwise the
 * last occurrence decides, so `--ignore-scripts=false` switches it off again.
 */
function booleanOption(tokens, name) {
  let state;
  for (const token of tokens) {
    if (token === name) state = true;
    else if (token.startsWith(`${name}=`)) state = token.slice(name.length + 1) !== 'false';
  }
  return state;
}

/** Whether the command asks the client to follow redirects. */
function followsRedirects(tokens) {
  return tokens.some((token) => (
    token === '--location'
    || (/^-[A-Za-z]+$/.test(token) && token.includes('L'))
  ));
}

/** Every URL argument of a command. */
function urlArguments(tokens) {
  return tokens.filter((token) => URL_TOKEN.test(token));
}

/**
 * Group the physical lines of a workflow into logical commands: a line that
 * ends with a backslash continues on the next one, and the flags of such a
 * command have to be read together.
 */
function logicalCommands(lines) {
  const commands = [];
  let buffer = null;
  let start = 0;
  let file = '';
  for (const line of lines) {
    const continued = /\\\s*$/.test(line.text);
    const piece = continued ? line.text.replace(/\\\s*$/, '') : line.text;
    if (buffer === null) {
      buffer = piece;
      start = line.number;
      file = line.file;
    } else {
      buffer = `${buffer} ${piece.trim()}`;
    }
    if (!continued) {
      commands.push({ file, number: start, text: buffer });
      buffer = null;
    }
  }
  if (buffer !== null) commands.push({ file, number: start, text: buffer });
  return commands;
}

/** Every line of every workflow file, with its file name and line number. */
function workflowLines() {
  const files = readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
  const lines = [];
  for (const file of files) {
    const content = readFileSync(join(WORKFLOW_DIR, file), 'utf8');
    content.split('\n').forEach((raw, index) => {
      lines.push({ file, number: index + 1, text: stripComment(raw) });
    });
  }
  return lines;
}

const violations = [];
let checked = 0;

for (const command of logicalCommands(workflowLines())) {
  const tokens = tokenize(command.text);
  if (tokens.length === 0) continue;
  checked += 1;
  const where = `${command.file}:${command.number}`;

  if (NPM_INSTALL.test(command.text)) {
    if (booleanOption(tokens, '--ignore-scripts') !== true) {
      violations.push(`${where}: package install without --ignore-scripts`);
    }
  }

  const isCurl = tokens.some((token) => CURL.test(token));
  const isWget = tokens.some((token) => WGET.test(token));
  if (!isCurl && !isWget) continue;

  for (const url of urlArguments(tokens)) {
    if (!url.toLowerCase().startsWith('https://')) {
      violations.push(`${where}: download over a protocol other than HTTPS (${url})`);
    }
  }

  if (isCurl) {
    if (lastOptionValue(tokens, '--proto') !== HTTPS_ONLY) {
      violations.push(`${where}: curl without --proto '=https'`);
    }
    if (followsRedirects(tokens) && lastOptionValue(tokens, '--proto-redir') !== HTTPS_ONLY) {
      violations.push(`${where}: curl follows redirects without --proto-redir '=https'`);
    }
  }

  if (isWget) {
    if (lastOptionValue(tokens, '--max-redirect') !== '0') {
      violations.push(`${where}: wget may follow redirects (--max-redirect=0 required)`);
    }
  }
}

if (violations.length > 0) {
  console.error('workflow hardening violated:');
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error('restore the protection or change this checker on purpose');
  process.exit(1);
}

console.log(`workflow hardening ok (${checked} commands checked)`);
