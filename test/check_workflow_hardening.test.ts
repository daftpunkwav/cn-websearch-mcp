/**
 * @file test/check_workflow_hardening
 * @description Tests for the workflow hardening gate.
 *
 * Responsibilities:
 * - Run the checker against fixture workflows written to a temp directory
 * - Assert that a workflow which keeps every protection passes
 * - Assert that each way of dropping a protection fails, with a message that
 *   names the file and the line
 * - Assert that the workflow still runs the gate, so the check cannot be
 *   dropped without a failing test
 * - Assert that every workflow file of the directory is checked
 *
 * Why these exist: the gate reads workflow files as text, so its decisions
 * come from pattern matching. A pattern that stops matching a missing
 * protection would let the protection disappear without a failing build, and
 * the protection is the thing the gate exists for.
 *
 * The checker is a script outside the vitest include, so it is exercised the
 * way it runs in CI: as a subprocess that reads a directory and exits with a
 * status.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const CHECKER = join(REPO_ROOT, 'scripts', 'ci', 'check_workflow_hardening.mjs');
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

interface CheckerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the checker against the files written into a temp directory. */
function runCheckerOn(files: Record<string, string>): CheckerResult {
  const dir = mkdtempSync(join(tmpdir(), 'cn-websearch-policy-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content, 'utf8');
    }
    const result = spawnSync(process.execPath, [CHECKER, dir], { encoding: 'utf8' });
    return {
      code: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run the checker against a workflow file written into a temp directory. */
function runChecker(workflow: string): CheckerResult {
  return runCheckerOn({ 'ci.yml': workflow });
}

/** A one-step workflow that runs the given command. */
function workflowWith(command: string): string {
  return ['jobs:', '  a:', '    steps:', `      - run: ${command}`, ''].join('\n');
}

/** A one-step workflow whose run block holds the given lines. */
function workflowWithBody(lines: string[]): string {
  return [
    'jobs:',
    '  a:',
    '    steps:',
    '      - run: |',
    ...lines.map((line) => `          ${line}`),
    '',
  ].join('\n');
}

/** A one-step workflow whose run block is a folded scalar. */
function workflowFolded(lines: string[]): string {
  return [
    'jobs:',
    '  a:',
    '    steps:',
    '      - run: >',
    ...lines.map((line) => `          ${line}`),
    '',
  ].join('\n');
}

// Each case is [name, workflow, the message the gate must report].
const REJECTED: [string, string, string][] = [
  ['a package install that runs lifecycle scripts', workflowWith('npm ci'), '--ignore-scripts'],
  ['an install alias that runs lifecycle scripts', workflowWith('npm i pkg'), '--ignore-scripts'],
  ['an install behind a global option', workflowWith('npm --prefix ./app ci'), '--ignore-scripts'],
  ['a rebuild that runs lifecycle scripts', workflowWith('npm rebuild'), '--ignore-scripts'],
  ['an install that switches the protection off again', workflowWith('npm ci --ignore-scripts=false'), '--ignore-scripts'],
  ['an install that switches the protection off with the negated form', workflowWith('npm ci --ignore-scripts --no-ignore-scripts'), '--ignore-scripts'],
  ['a download over cleartext HTTP', workflowWith('curl -sSf http://example.com/x'), 'other than HTTPS'],
  ['a cleartext URL in any command', workflowWith('node scripts/fetch.js http://example.com/x'), 'other than HTTPS'],
  ['a protocol list that also allows HTTP', workflowWith('curl -sSf --proto \'=https,http\' https://example.com/x'), '--proto \'=https\''],
  ['a redirect chain that may leave HTTPS', workflowWith('curl -sSfL --proto \'=https\' --tlsv1.2 https://example.com/x'), '--proto-redir \'=https\''],
  ['a redirect chain that trusts the location', workflowWith('curl -sSfL --location-trusted --proto \'=https\' --tlsv1.2 https://example.com/x'), '--proto-redir \'=https\''],
  ['a curl that reads its options from a file', workflowWith("curl -sSf --proto '=https' --config curl.conf https://example.com/x"), 'cannot check'],
  ['a curl that is not on the path', workflowWith('/usr/bin/curl -sSf https://example.com/x'), "--proto '=https'"],
  ['a second curl transfer without its own pins', workflowWith("curl --proto '=https' --proto-redir '=https' --tlsv1.2 https://a.example/x --next curl https://b.example/x"), "--proto '=https'"],
  ['a command split over two lines', workflowWithBody(["curl -sSfL --proto '=https' --tlsv1.2 \\", '  https://example.com/x']), "--proto-redir '=https'"],
  ['a folded install that switches the protection off', workflowFolded(['npm', 'ci --ignore-scripts=false']), '--ignore-scripts'],
  ['a wget that may follow redirects', workflowWith('wget https://example.com/x'), '--max-redirect=0'],
  ['a wget whose URL the gate cannot read', workflowWith('wget --max-redirect 0 "$URL"'), 'cannot check'],
  ['a wget that reads its URLs from a file', workflowWith('wget --max-redirect 0 --input-file=urls.txt'), 'cannot check'],
  ['a curl that may negotiate an older TLS version', workflowWith("curl -sSf --proto '=https' https://example.com/x"), '--tlsv1.2'],
];

// Each case is [name, workflow].
const ACCEPTED: [string, string][] = [
  ['a workflow that keeps every protection', workflowWithBody([
    'npm ci --ignore-scripts',
    "curl -sSfL --proto '=https' --proto-redir '=https' --tlsv1.2 -o /tmp/tool \\",
    '  "https://example.com/tool.tgz"',
  ])],
  ['a wget that refuses redirects', workflowWith('wget --max-redirect 0 https://example.com/x')],
  ['a command that only appears in a comment', workflowWith('# npm ci without the flag')],
  ['an npm script that is not an install', workflowWith('npm run ci')],
];

describe('workflow hardening gate', () => {
  it.each(REJECTED)('rejects %s', (_name, workflow, message) => {
    const result = runChecker(workflow);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it.each(ACCEPTED)('accepts %s', (_name, workflow) => {
    const result = runChecker(workflow);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('workflow hardening ok');
  });

  it('keeps the gate wired into the workflow', () => {
    // Without this, dropping the step that runs the gate would leave the
    // policy job and the overall gate green.
    expect(readFileSync(WORKFLOW, 'utf8')).toContain('scripts/ci/check_workflow_hardening.mjs');
  });

  it('checks every workflow file of the directory', () => {
    // A gate that reads one file would leave the other workflows unchecked.
    const result = runCheckerOn({
      'ci.yml': workflowWith('npm ci --ignore-scripts'),
      'security.yml': workflowWith('npm ci'),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('security.yml:4');
  });

  it('leaves a file that is not a workflow file alone', () => {
    const result = runCheckerOn({ 'notes.txt': 'npm ci' });
    expect(result.code).toBe(0);
  });
});
