/**
 * @file test/check_workflow_hardening
 * @description Tests for the workflow hardening gate.
 *
 * Responsibilities:
 * - Run the checker against fixture workflows written to a temp directory
 * - Assert that a workflow which keeps every protection passes
 * - Assert that each way of dropping a protection fails, with a message that
 *   names the file and the line
 * - Assert that a download the gate cannot read fails, whether the URL is
 *   assembled in code, arrives through a variable, or runs under a client the
 *   gate does not know
 * - Assert that the run: scalar of a step is read as YAML, in every form it
 *   can take
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
function workflowFolded(lines: string[], indicator = '>'): string {
  return [
    'jobs:',
    '  a:',
    '    steps:',
    `      - run: ${indicator}`,
    ...lines.map((line) => `          ${line}`),
    '',
  ].join('\n');
}

/** A one-step workflow whose run value is a quoted scalar. */
function workflowQuoted(value: string): string {
  return ['jobs:', '  a:', '    steps:', `      - run: "${value}"`, ''].join('\n');
}

/** A one-step workflow whose run value continues on the lines below it. */
function workflowContinued(lines: string[]): string {
  return [
    'jobs:',
    '  a:',
    '    steps:',
    '      - run: npm ci',
    ...lines.map((line) => `          ${line}`),
    '',
  ].join('\n');
}

/** A workflow that carries the line endings of Windows. */
function workflowWithCarriageReturns(workflow: string): string {
  return workflow.replace(/\n/g, '\r\n');
}

/** A one-step workflow whose run value holds the given lines below an empty key. */
function workflowEmptyRunValue(lines: string[]): string {
  return [
    'jobs:',
    '  a:',
    '    steps:',
    '      - run:',
    ...lines.map((line) => `          ${line}`),
    '',
  ].join('\n');
}

/**
 * A two-job workflow whose second steps: key carries a trailing comment. The
 * first job keeps a plain steps: key, so the file reads as a workflow with a
 * steps: list in it.
 */
function workflowStepsWithComment(command: string): string {
  return [
    'jobs:',
    '  a:',
    '    steps:',
    '      - run: npm ci --ignore-scripts',
    '  b:',
    '    steps:  # the steps of the job',
    `      - run: ${command}`,
    '',
  ].join('\n');
}

/** A one-step workflow whose sequence starts at the column of the steps: key. */
function workflowSequenceAtKeyColumn(command: string): string {
  return ['jobs:', '  a:', '    steps:', `    - run: ${command}`, ''].join('\n');
}

/** A one-step workflow whose run value is a quoted scalar over two lines. */
function workflowQuotedOverTwoLines(first: string, second: string): string {
  return [
    'jobs:',
    '  a:',
    '    steps:',
    `      - run: "${first}`,
    `          ${second}"`,
    '',
  ].join('\n');
}

// Each case is [name, workflow, the message the gate must report].
const REJECTED: [string, string, string][] = [
  ['a package install that runs lifecycle scripts', workflowWith('npm ci'), '--ignore-scripts'],
  ['an install alias that runs lifecycle scripts', workflowWith('npm i pkg'), '--ignore-scripts'],
  ['an add that runs lifecycle scripts', workflowWith('npm add lodash'), '--ignore-scripts'],
  ['an update alias that runs lifecycle scripts', workflowWith('npm up'), '--ignore-scripts'],
  ['a dedupe that runs lifecycle scripts', workflowWith('npm dedupe'), '--ignore-scripts'],
  ['an install behind a global option', workflowWith('npm --prefix ./app ci'), '--ignore-scripts'],
  ['an install behind a path in front of npm', workflowWith('/usr/local/bin/npm ci'), '--ignore-scripts'],
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
  ['a curl that caps the TLS version instead of pinning it', workflowWith("curl -sSf --proto '=https' --tls-max 1.2 https://example.com/x"), '--tlsv1.2'],
  ['a curl whose URL arrives through a variable', workflowWith("curl \"$URL\" --proto '=https' --tlsv1.2"), 'curl without a URL the gate cannot check'],
  ['a curl without a URL at all', workflowWith("curl --proto '=https' --tlsv1.2"), 'curl without a URL the gate cannot check'],
  ['a URL whose scheme is assembled in code', workflowWith("python -c \"urlopen('http' + '://' + host)\""), 'scheme the gate cannot read'],
  ['a URL that is assembled in code', workflowWith("python -c \"urllib.request.urlopen('http://' + host)\""), 'other than HTTPS'],
  ['a download with a client the gate does not know', workflowWith('aria2c https://example.com/x'), 'client the gate cannot check'],
  ['a download written with a script', workflowWith('node scripts/fetch.js https://example.com/x'), 'client the gate cannot check'],
  ['an install behind an environment assignment', workflowWith('FOO=1 npm ci'), '--ignore-scripts'],
  ['a curl inside a command substitution', workflowWith("V=$(curl -sSfL --proto '=https' --tlsv1.2 https://example.com/x)"), "--proto-redir '=https'"],
  ['a URL whose scheme sits behind a brace', workflowWith("python -c \"u.urlopen(f'{scheme}://{host}')\""), 'scheme the gate cannot read'],
  // The scheme of the URL is written in parts, so the string does not read as
  // a template expression.
  ['a URL whose scheme comes from a variable', workflowWith(['echo "$', '{SCHEME}://example.com/x"'].join('')), 'scheme the gate cannot read'],
  ['a download in a workflow with Windows line endings', workflowWithCarriageReturns(workflowWith('curl -sSf http://example.com/x')), 'other than HTTPS'],
  ['a download inside a quoted script', workflowWith('sh -c "curl -sSfL https://example.com/x"'), 'client the gate cannot check'],
  ['a known program behind an unknown program', workflowWith('node fetch.js https://example.com/x vendor/git'), 'client the gate cannot check'],
  ['a run value that starts on the line below it', workflowEmptyRunValue(['npm ci']), '--ignore-scripts'],
  ['a steps: key with a trailing comment', workflowStepsWithComment('npm ci'), '--ignore-scripts'],
  ['a sequence at the column of the steps: key', workflowSequenceAtKeyColumn('npm ci'), '--ignore-scripts'],
  ['a command in a quoted value that spans two lines', workflowQuotedOverTwoLines('npm ci', '&& echo done'), '--ignore-scripts'],
  ['a client behind an unknown program', workflowWith("node fetch.js https://example.com/x curl --proto '=https' --tlsv1.2"), 'client the gate cannot check'],
  ['a command behind a comment in the run value', workflowEmptyRunValue(['# a comment', 'npm ci']), '--ignore-scripts'],
  ['a command behind a comment that carries a colon', workflowEmptyRunValue(['# note: this installs', 'npm ci']), '--ignore-scripts'],
  ['a curl inside a command substitution of a known program', workflowWith('echo "$(curl -sSfL https://example.com/x)"'), "--proto '=https'"],
  ['an install inside a command substitution of a known program', workflowWith('echo "$(npm ci)"'), '--ignore-scripts'],
  ['a curl inside a nested command substitution', workflowWith('echo "$(echo $(curl -sSfL https://example.com/x))"'), "--proto '=https'"],
  ['a client after an assignment that carries a substitution', workflowWith('FOO=$(printf ok) curl -sSfL https://example.com/x'), "--proto '=https'"],
  ['a client after an escaped parenthesis in a substitution', workflowWith('echo "$(printf \\) ; curl -sSfL https://example.com/x)"'), "--proto '=https'"],
  ['a client after a quoted parenthesis in a substitution', workflowWith("echo \"$(printf ')' ; curl -sSfL https://example.com/x)\""), "--proto '=https'"],
  ['a client after a group in a substitution', workflowWith('echo "$( (printf ok) ; curl -sSfL https://example.com/x)"'), "--proto '=https'"],
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
  ['an install behind a path in front of npm that keeps its protection', workflowWith('/usr/local/bin/npm ci --ignore-scripts')],
  ['a registry the gate reads as a value', workflowWith('npm ci --registry https://registry.npmjs.org --ignore-scripts')],
  ['a folded block that joins its lines', workflowFolded([
    'curl -sSfL --proto \'=https\' --proto-redir \'=https\' --tlsv1.2',
    'https://example.com/x',
  ])],
  ['a folded block that keeps its trailing newlines', workflowFolded([
    "curl -sSfL --proto '=https' --proto-redir '=https' --tlsv1.2",
    'https://example.com/x',
  ], '>+')],
  ['a quoted run value', workflowQuoted('npm ci --ignore-scripts')],
  ['a run value that continues on the next line', workflowContinued(['--ignore-scripts'])],
  ['a URL outside the run: scalar of a step', [
    'jobs:',
    '  a:',
    '    env:',
    '      URL: http://example.com/x',
    '    steps:',
    '      - run: npm ci --ignore-scripts',
    '',
  ].join('\n')],
  ['a registry of another package manager', workflowWith('pnpm install --registry https://r.example/ --ignore-scripts')],
  ['a curl whose URL its --url option names', workflowWith("curl -sSfL --proto '=https' --proto-redir '=https' --tlsv1.2 --url=https://example.com/x")],
  ['a URL that a program prints', workflowWith('echo "https://example.com/x"')],
  ['a source tree that git clones', workflowWith('git clone https://example.com/x')],
  ['a run: key that is an input of an action', [
    'jobs:',
    '  a:',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          run: npm ci',
    '      - run: npm ci --ignore-scripts',
    '',
  ].join('\n')],
  ['a run: key that holds a nested mapping', [
    'jobs:',
    '  a:',
    '    steps:',
    '      - run: npm ci --ignore-scripts',
    '    defaults:',
    '      run:',
    '        shell: bash',
    '',
  ].join('\n')],
  ['a run: key of a step that holds a nested mapping', workflowEmptyRunValue(['shell: bash'])],
  ['a run: key of a step that holds a nested mapping with a quoted key', workflowEmptyRunValue(['"shell": bash'])],
  ['a run: key of a step that holds a sequence', workflowEmptyRunValue(['- echo hi'])],
  ['a run: key of a step whose next line is a mapping key with a colon in it', workflowEmptyRunValue(['echo hello: world'])],
  ['a sequence at the column of the steps: key that keeps its protection', workflowSequenceAtKeyColumn('npm ci --ignore-scripts')],
  ['a steps: key with a trailing comment that keeps its protection', workflowStepsWithComment('npm ci --ignore-scripts')],
  ['an install behind an environment assignment that keeps its protection', workflowWith('FOO=1 npm ci --ignore-scripts')],
  ['a substitution that is only text', workflowWith("echo '$(curl https://example.com/x)'")],
  ['a curl inside a command substitution that keeps its protection', workflowWith('echo "$(curl -sSfL --proto \'=https\' --proto-redir \'=https\' --tlsv1.2 https://example.com/x)"')],
  ['a client after an escaped parenthesis that keeps its protection', workflowWith("echo \"$(printf \\) ; curl -sSfL --proto '=https' --proto-redir '=https' --tlsv1.2 https://example.com/x)\"")],
  ['a client after a quoted parenthesis that keeps its protection', workflowWith("echo \"$(printf ')' ; curl -sSfL --proto '=https' --proto-redir '=https' --tlsv1.2 https://example.com/x)\"")],
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
