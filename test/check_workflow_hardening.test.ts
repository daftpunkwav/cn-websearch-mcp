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

/** Run the checker against a workflow file written into a temp directory. */
function runChecker(workflow: string): CheckerResult {
  const dir = mkdtempSync(join(tmpdir(), 'cn-websearch-policy-'));
  try {
    writeFileSync(join(dir, 'ci.yml'), workflow, 'utf8');
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

const REJECTED: { name: string; workflow: string; message: string }[] = [
  {
    name: 'a package install that runs lifecycle scripts',
    workflow: workflowWith('npm ci'),
    message: '--ignore-scripts',
  },
  {
    name: 'an install alias that runs lifecycle scripts',
    workflow: workflowWith('npm i pkg'),
    message: '--ignore-scripts',
  },
  {
    name: 'an install behind a global option',
    workflow: workflowWith('npm --prefix ./app ci'),
    message: '--ignore-scripts',
  },
  {
    name: 'a rebuild that runs lifecycle scripts',
    workflow: workflowWith('npm rebuild'),
    message: '--ignore-scripts',
  },
  {
    name: 'an install that switches the protection off again',
    workflow: workflowWith('npm ci --ignore-scripts=false'),
    message: '--ignore-scripts',
  },
  {
    name: 'an install that switches the protection off with the negated form',
    workflow: workflowWith('npm ci --ignore-scripts --no-ignore-scripts'),
    message: '--ignore-scripts',
  },
  {
    name: 'a download over cleartext HTTP',
    workflow: workflowWith('curl -sSf http://example.com/x'),
    message: 'other than HTTPS',
  },
  {
    name: 'a cleartext URL in any command',
    workflow: workflowWith('node scripts/fetch.js http://example.com/x'),
    message: 'other than HTTPS',
  },
  {
    name: 'a protocol list that also allows HTTP',
    workflow: workflowWith("curl -sSf --proto '=https,http' https://example.com/x"),
    message: "--proto '=https'",
  },
  {
    name: 'a redirect chain that may leave HTTPS',
    workflow: workflowWith("curl -sSfL --proto '=https' --tlsv1.2 https://example.com/x"),
    message: "--proto-redir '=https'",
  },
  {
    name: 'a redirect chain that trusts the location',
    workflow: workflowWith("curl -sSfL --location-trusted --proto '=https' --tlsv1.2 https://example.com/x"),
    message: "--proto-redir '=https'",
  },
  {
    name: 'a curl that may negotiate an older TLS version',
    workflow: workflowWith("curl -sSf --proto '=https' https://example.com/x"),
    message: '--tlsv1.2',
  },
  {
    name: 'a curl that reads its options from a file',
    workflow: workflowWith("curl -sSf --proto '=https' --config curl.conf https://example.com/x"),
    message: 'cannot check',
  },
  {
    name: 'a curl that is not on the path',
    workflow: workflowWith('/usr/bin/curl -sSf https://example.com/x'),
    message: "--proto '=https'",
  },
  {
    name: 'a second curl transfer without its own pins',
    workflow: workflowWith("curl --proto '=https' --proto-redir '=https' --tlsv1.2 https://a.example/x --next curl https://b.example/x"),
    message: "--proto '=https'",
  },
  {
    name: 'a command split over two lines',
    workflow: workflowWithBody([
      "curl -sSfL --proto '=https' --tlsv1.2 \\",
      '  https://example.com/x',
    ]),
    message: "--proto-redir '=https'",
  },
  {
    name: 'a folded install that switches the protection off',
    workflow: workflowFolded(['npm', 'ci --ignore-scripts=false']),
    message: '--ignore-scripts',
  },
  {
    name: 'a wget that may follow redirects',
    workflow: workflowWith('wget https://example.com/x'),
    message: '--max-redirect=0',
  },
  {
    name: 'a wget whose URL the gate cannot read',
    workflow: workflowWith('wget --max-redirect 0 "$URL"'),
    message: 'cannot check',
  },
  {
    name: 'a wget that reads its URLs from a file',
    workflow: workflowWith('wget --max-redirect 0 --input-file=urls.txt'),
    message: 'cannot check',
  },
];

const ACCEPTED: { name: string; workflow: string }[] = [
  {
    name: 'a workflow that keeps every protection',
    workflow: workflowWithBody([
      'npm ci --ignore-scripts',
      "curl -sSfL --proto '=https' --proto-redir '=https' --tlsv1.2 -o /tmp/tool \\",
      '  "https://example.com/tool.tgz"',
    ]),
  },
  {
    name: 'a wget that refuses redirects',
    workflow: workflowWith('wget --max-redirect 0 https://example.com/x'),
  },
  {
    name: 'a command that only appears in a comment',
    workflow: workflowWith('# npm ci without the flag'),
  },
  {
    name: 'an npm script that is not an install',
    workflow: workflowWith('npm run ci'),
  },
];

describe('workflow hardening gate', () => {
  it.each(REJECTED)('rejects $name', ({ workflow, message }) => {
    const result = runChecker(workflow);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it.each(ACCEPTED)('accepts $name', ({ workflow }) => {
    const result = runChecker(workflow);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('workflow hardening ok');
  });

  it('keeps the gate wired into the workflow', () => {
    // Without this, dropping the step that runs the gate would leave the
    // policy job and the overall gate green.
    expect(readFileSync(WORKFLOW, 'utf8')).toContain('scripts/ci/check_workflow_hardening.mjs');
  });
});
