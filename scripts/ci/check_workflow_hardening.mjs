#!/usr/bin/env node
/**
 * Workflow hardening check: fail when a workflow step drops a protection.
 *
 * Responsibilities:
 * - Fail when a package install in a workflow runs dependency lifecycle
 *   scripts
 * - Fail when a download in a workflow uses another protocol than HTTPS, or
 *   follows a redirect that may leave HTTPS
 * - Fail when a download in a workflow is one the gate cannot read, whether
 *   the URL is assembled in code, arrives through a variable or a file, or
 *   runs under a client the gate does not know
 * - Read the workflow directory only: no install and no network required
 *
 * Usage: `node scripts/ci/check_workflow_hardening.mjs [workflow-dir]`
 *
 * Why: both protections are one edit away from being dropped by a later edit,
 * and nothing else in the build would notice that they were gone. The check
 * reads the run: scalar of a step as YAML, because that scalar is where the
 * commands of a step live, and reads the shell in it as the commands it runs.
 *
 * What the gate cannot read, it rejects: a URL whose scheme the text does not
 * spell out, a URL that arrives through a variable or a file, and a download
 * that runs under a client the gate does not know. The one residual is a URL
 * that no `://` in the text points at.
 *
 * The reading of a workflow file, the reading of a shell line and the rules
 * that decide whether a command keeps its protection live in the modules
 * under `scripts/ci/workflow/`.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cleartextViolation, downloadViolation, unreadableUrlViolation,
} from './workflow/download_policy.mjs';
import { installViolation } from './workflow/install_policy.mjs';
import readWorkflowCommands from './workflow/workflow_lines.mjs';
import readWorkflowFiles from './workflow/workflow_files.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_DIR = process.argv[2]
  ? resolve(process.argv[2])
  : join(REPO_ROOT, '.github', 'workflows');

/**
 * The violation a command carries, or null when it keeps every protection.
 */
function violationOf(args) {
  return cleartextViolation(args)
    ?? unreadableUrlViolation(args)
    ?? installViolation(args)
    ?? downloadViolation(args);
}

/**
 * The lines of a workflow file, with the number each line carries. The line
 * ending is cut off, so a file that carries the line endings of Windows is
 * read the same way as a file that carries the line endings of Unix.
 */
function linesOf(text) {
  return text
    .split('\n')
    .map((line, index) => ({ text: line.replace(/\r$/, ''), number: index + 1 }));
}

const violations = [];
let checked = 0;

for (const workflow of readWorkflowFiles(WORKFLOW_DIR)) {
  for (const command of readWorkflowCommands(linesOf(workflow.text))) {
    checked += 1;
    const violation = violationOf(command.args);
    if (violation) violations.push(`${workflow.name}:${command.number}: ${violation}`);
  }
}

if (violations.length > 0) {
  console.error('workflow hardening violated:');
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error('restore the protection or change this checker on purpose');
  process.exit(1);
}

console.log(`workflow hardening ok (${checked} commands checked)`);
