/**
 * @file workflow/workflow_files
 * @description Read the workflow files the gate checks.
 *
 * Responsibilities:
 * - List the workflow files of a directory
 * - Read each of them as text
 *
 * Constraints:
 * - The gate reads one directory and nothing else. The names come from the
 *   listing of that directory, and only a plain name is joined onto it, so
 *   a read can never leave the directory.
 * - Only files with a workflow extension are read; every other entry of the
 *   directory is left alone.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The extensions of a workflow file.
const WORKFLOW_EXTENSIONS = ['.yml', '.yaml'];

/** Whether the name is a plain file name, without a path in it. */
function isPlainName(name) {
  return !name.includes('/') && !name.includes('\\');
}

/** Whether the name is the name of a workflow file inside the directory. */
function isWorkflowFile(name) {
  if (!WORKFLOW_EXTENSIONS.some((extension) => name.endsWith(extension))) return false;
  return isPlainName(name);
}

/**
 * The workflow files of the directory, with their text, in the order of
 * their names.
 */
export default function readWorkflowFiles(directory) {
  const names = readdirSync(directory).filter((name) => isWorkflowFile(name)).sort();
  return names.map((name) => ({ name, text: readFileSync(join(directory, name), 'utf8') }));
}
