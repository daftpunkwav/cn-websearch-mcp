#!/usr/bin/env node
/**
 * Workflow hardening check: fail when a workflow step drops a protection.
 *
 * Responsibilities:
 * - Fail when a package install in a workflow runs dependency lifecycle
 *   scripts
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
 *
 * The reading of a workflow file, the reading of a shell line and the rules
 * that decide whether a command keeps its protection live in the modules
 * under `scripts/ci/workflow/`.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleartextViolation, downloadViolation } from './workflow/download_policy.mjs';
import { installViolation } from './workflow/install_policy.mjs';
import { commandsOf } from './workflow/workflow_lines.mjs';
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
    ?? installViolation(args)
    ?? downloadViolation(args);
}

/** The lines of a workflow file, with the number each line carries. */
function linesOf(text) {
  return text.split('\n').map((line, index) => ({ text: line, number: index + 1 }));
}

const violations = [];
let checked = 0;

for (const workflow of readWorkflowFiles(WORKFLOW_DIR)) {
  for (const command of commandsOf(linesOf(workflow.text))) {
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
