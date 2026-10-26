/**
 * @file workflow/workflow_lines
 * @description Read the lines of a workflow file as the commands they run.
 *
 * Responsibilities:
 * - Join the lines of a folded YAML scalar into one line
 * - Join a line that ends with a backslash with the line after it
 * - Cut the comment off every line
 * - Split the logical lines into the commands they run
 *
 * Constraints:
 * - The YAML reading is deliberately narrow: the `run:` scalar of a step is
 *   the only shape that spans more than one line, and only a folded scalar
 *   joins its lines without a backslash.
 */

import { argumentsOf, splitCommands, stripComment } from './shell_line.mjs';

// The run scalars whose lines belong to one command.
const FOLDED_SCALARS = new Set(['run: >', '- run: >', 'run: >-', '- run: >-']);

/** Whether a line opens a folded YAML scalar. */
export function opensFoldedScalar(text) {
  return FOLDED_SCALARS.has(text.trim());
}

/** The indentation of a line, in characters. */
function indentWidth(text) {
  return text.length - text.trimStart().length;
}

/**
 * What a line does to the scalar that is open above it: it joins the
 * scalar, it is a blank line inside it, or it ends it.
 */
function foldedContinuation(line, indent, width) {
  if (indent === null) return 'none';
  if (line.text.trim() === '') return 'blank';
  return width > indent ? 'join' : 'none';
}

/** Add the line to the scalar that was opened above it. */
function appendToPrevious(folded, line) {
  const previous = folded[folded.length - 1];
  previous.text = `${previous.text} ${line.text.trim()}`;
}

/**
 * The lines of a workflow file with the folded scalars joined: a `run: >`
 * block is one command, while a literal `run: |` block keeps one command per
 * line.
 */
export function foldScalars(lines) {
  const folded = [];
  let indent = null;
  for (const line of lines) {
    const width = indentWidth(line.text);
    const continuation = foldedContinuation(line, indent, width);
    if (continuation === 'blank') {
      folded.push(line);
      continue;
    }
    if (continuation === 'join') {
      appendToPrevious(folded, line);
      continue;
    }
    indent = null;
    folded.push({ ...line });
    if (opensFoldedScalar(line.text)) indent = width;
  }
  return folded;
}

/** Whether the line continues on the next one. */
function isContinued(text) {
  return /\\\s*$/.test(text);
}

/** The line without the backslash that continues it. */
function trimContinuation(text) {
  return text.replace(/\\\s*$/, '');
}

/**
 * The lines of a workflow file with the comment cut off and the continued
 * lines marked.
 */
function linePieces(lines) {
  const pieces = [];
  for (const line of foldScalars(lines)) {
    const text = stripComment(line.text);
    const continued = isContinued(text);
    const piece = continued ? trimContinuation(text) : text;
    pieces.push({ text: piece, continued, number: line.number });
  }
  return pieces;
}

/**
 * The logical lines of a workflow file: a folded scalar is one line, and a
 * line that ends with a backslash continues on the next one.
 */
export function logicalLines(lines) {
  const logical = [];
  let buffer = null;
  let start = 0;
  for (const piece of linePieces(lines)) {
    if (buffer === null) {
      buffer = piece.text;
      start = piece.number;
    } else {
      buffer = `${buffer} ${piece.text.trim()}`;
    }
    if (piece.continued) continue;
    logical.push({ text: buffer, number: start });
    buffer = null;
  }
  if (buffer !== null) logical.push({ text: buffer, number: start });
  return logical;
}

/**
 * The commands of a workflow file: a folded scalar is one command, a literal
 * block is one command per line, and a line that ends with a backslash
 * continues on the next one.
 */
export function commandsOf(lines) {
  const commands = [];
  for (const line of logicalLines(lines)) {
    for (const part of splitCommands(line.text)) {
      const args = argumentsOf(part);
      if (args.length > 0) commands.push({ number: line.number, args });
    }
  }
  return commands;
}
