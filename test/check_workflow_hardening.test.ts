/**
 * @file test/check_workflow_hardening
 * @description Tests for the workflow hardening gate.
 *
 * Responsibilities:
 * - Run the checker against fixture workflows written to a temp directory
 * - Assert that a workflow that keeps every protection passes
 * - Assert that each way of dropping a protection fails, with a message that
 *   names the file and the line
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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const CHECKER = join(REPO_ROOT, 'scripts', 'ci', 'check_workflow_hardening.mjs');

interface CheckerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the checker against a workflow file written into a temp directory. */
function runChecker(workflow: string, fileName = 'ci.yml'): CheckerResult {
  const dir = mkdtempSync(join(tmpdir(), 'cn-websearch-policy-'));
  try {
    writeFileSync(join(dir, fileName), workflow, 'utf8');
    const result = spawnSync(process.execPath, [CHECKER, dir], { encoding: 'utf8' });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PROTECTED_WORKFLOW = `name: Example

on: [push]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci --ignore-scripts
      - run: |
          set -euo pipefail
          curl -sSfL --proto '=https' --proto-redir '=https' --tlsv1.2 -o /tmp/tool \\
            "https://example.com/tool.tgz"
`;

describe('workflow hardening gate', () => {
  it('accepts a workflow that keeps every protection', () => {
    const result = runChecker(PROTECTED_WORKFLOW);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('workflow hardening ok');
  });

  it('rejects a package install that runs lifecycle scripts', () => {
    const result = runChecker('jobs:\n  a:\n    steps:\n      - run: npm ci\n');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--ignore-scripts');
  });

  it('rejects an install alias that runs lifecycle scripts', () => {
    const result = runChecker('jobs:\n  a:\n    steps:\n      - run: npm i pkg\n');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--ignore-scripts');
  });

  it('rejects an install that switches the protection off again', () => {
    const result = runChecker('jobs:\n  a:\n    steps:\n      - run: npm ci --ignore-scripts=false\n');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--ignore-scripts');
  });

  it('rejects a download over cleartext HTTP', () => {
    const result = runChecker('jobs:\n  a:\n    steps:\n      - run: curl -sSf http://example.com/x\n');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('other than HTTPS');
  });

  it('rejects a protocol list that also allows HTTP', () => {
    const result = runChecker("jobs:\n  a:\n    steps:\n      - run: curl -sSf --proto '=https,http' https://example.com/x\n");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--proto '=https'");
  });

  it('rejects a redirect chain that may leave HTTPS', () => {
    const result = runChecker("jobs:\n  a:\n    steps:\n      - run: curl -sSfL --proto '=https' https://example.com/x\n");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--proto-redir '=https'");
  });

  it('reads the flags of a command split over two lines', () => {
    const split = [
      'jobs:',
      '  a:',
      '    steps:',
      '      - run: |',
      '          curl -sSfL --proto \'=https\' \\',
      '            https://example.com/x',
      '',
    ].join('\n');
    const result = runChecker(split);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--proto-redir '=https'");
  });

  it('rejects a wget that may follow redirects', () => {
    const result = runChecker('jobs:\n  a:\n    steps:\n      - run: wget https://example.com/x\n');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--max-redirect=0');
  });

  it('accepts a wget that refuses redirects', () => {
    const result = runChecker('jobs:\n  a:\n    steps:\n      - run: wget --max-redirect 0 https://example.com/x\n');
    expect(result.code).toBe(0);
  });

  it('ignores a command that only appears in a comment', () => {
    const result = runChecker('jobs:\n  a:\n    steps:\n      # npm ci without the flag\n      - run: node -e "0"\n');
    expect(result.code).toBe(0);
  });
});
