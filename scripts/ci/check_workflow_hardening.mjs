#!/usr/bin/env node
/**
 * Workflow hardening check: fail when a workflow step drops a protection.
 *
 * Responsibilities:
 * - Fail when an npm install in a workflow runs without `--ignore-scripts`
 * - Fail when a curl that follows redirects does not pin the protocol to HTTPS
 * - Fail when a wget in a workflow may follow redirects
 * - Read `.github/workflows/*.yml` only: no install and no network required
 *
 * Why: both protections are one flag away from being dropped by a later edit,
 * and nothing else in the build would notice that they were gone. The check
 * is text-based on purpose - the repository has no YAML parser in its
 * toolchain, and a workflow line is where these flags live.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

// An npm install command: `npm ci` or `npm install`, but not `npm install-scripts`.
const NPM_INSTALL = /\bnpm\s+(?:ci|install)(?![\w-])/;
const IGNORE_SCRIPTS = '--ignore-scripts';
// A curl/wget invocation at the start of a command word.
const CURL = /(?<![\w-])curl(?![\w-])/;
const WGET = /(?<![\w-])wget(?![\w-])/;
// Redirect following: the long option, or an 'L' inside a short-flag bundle.
const FOLLOWS_REDIRECTS = /--location\b|(?<![\w-])-[a-zA-Z]*L[a-zA-Z]*(?=\s|$)/;
// The protocol pin, in either `--proto '=https'` or `--proto=https` spelling.
const PROTO_HTTPS = /--proto[= ]+['"]?=https/;
const PROTO_REDIR_HTTPS = /--proto-redir[= ]+['"]?=https/;
// wget has no protocol switch, so the only way to refuse a redirect is to
// refuse to follow it at all.
const MAX_REDIRECT_ZERO = /--max-redirect=0\b/;

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

for (const { file, number, text } of workflowLines()) {
  const where = `${file}:${number}`;

  if (NPM_INSTALL.test(text)) {
    checked += 1;
    if (!text.includes(IGNORE_SCRIPTS)) {
      violations.push(`${where}: npm install without ${IGNORE_SCRIPTS}`);
    }
  }

  if (CURL.test(text)) {
    checked += 1;
    if (FOLLOWS_REDIRECTS.test(text)) {
      if (!PROTO_HTTPS.test(text)) {
        violations.push(`${where}: curl follows redirects without --proto '=https'`);
      }
      if (!PROTO_REDIR_HTTPS.test(text)) {
        violations.push(`${where}: curl follows redirects without --proto-redir '=https'`);
      }
    }
  }

  if (WGET.test(text)) {
    checked += 1;
    if (!MAX_REDIRECT_ZERO.test(text)) {
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
