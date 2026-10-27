/**
 * @file workflow/workflow_lines
 * @description Read the run: scalars of a workflow file as the commands they run.
 *
 * Responsibilities:
 * - Find the run: key of every step of a workflow file
 * - Read the scalar the key holds: a plain or a quoted value, a literal block
 *   or a folded block
 * - Join the lines of a folded block into one line, and keep the lines of a
 *   literal block apart
 * - Join a line that ends with a backslash with the line after it
 * - Cut the comment off every line
 * - Split the logical lines into the commands they run
 *
 * Constraints:
 * - The reader covers the run: scalar of a step and nothing else. A workflow
 *   carries shell in that scalar alone, so a step is read as YAML in the one
 *   place where it is YAML, and every command in it is read as a command.
 * - The reader follows the YAML block scalar rules: the content of a block
 *   is deeper than its key, and the first content line sets the indentation
 *   of the whole block.
 * - The keys of a step sit at the column where the item of the steps: list
 *   starts. A run: key deeper than that belongs to a nested mapping, such as
 *   the inputs of an action, and holds no command.
 */

import { argumentsOf, splitCommands, stripComment } from './shell_line.mjs';

// The indicator of a YAML block scalar: `|` keeps the lines, `>` folds them.
const BLOCK_INDICATOR = /^[|>][0-9+-]*$/;

/** The indentation of a line, in characters. */
function indentWidth(text) {
  return text.length - text.trimStart().length;
}

/**
 * The run: key of a line, with the column it starts at and the value that
 * follows it, or null when the line carries no run: key.
 */
function runKeyOf(line) {
  const colon = line.text.indexOf(':');
  if (colon === -1) return null;
  const name = line.text.slice(0, colon).trim().replace(/\s+/, ' ');
  if (name !== 'run' && name !== '- run') return null;
  return { column: line.text.indexOf('run'), value: line.text.slice(colon + 1) };
}

/**
 * The list item a line starts, with the column of its marker and the column
 * of its content. A dash that is not followed by a space starts a value, not
 * an item.
 */
function listItemOf(line) {
  const dash = line.text.indexOf('-');
  if (dash === -1) return null;
  if (line.text.slice(0, dash).trim() !== '') return null;
  const rest = line.text.slice(dash + 1);
  if (rest === '') return { marker: dash, content: dash + 2 };
  if (!/^\s/.test(rest)) return null;
  const spaces = rest.length - rest.trimStart().length;
  return { marker: dash, content: dash + 1 + spaces };
}

/**
 * Whether the line holds the run: key of a step. A key with no value holds a
 * nested mapping, a key outside the steps: list of a job belongs to another
 * mapping, and a key deeper than the keys of its item belongs to a nested
 * mapping of the step.
 */
function isStepRunKey(context, key) {
  if (key.value.trim() === '') return false;
  if (context.stepsColumn === null && context.hasSteps) return false;
  if (context.itemColumn === null) return true;
  return context.itemColumn === key.column;
}

/**
 * Whether a line belongs to the value of a key: it is deeper than the key,
 * and it is not left of the indentation the value set.
 */
function belongsToValue(width, indent, keyColumn) {
  if (indent === null) return width > keyColumn;
  return width >= indent;
}

/**
 * The lines that belong to the value of a key, with the indentation the
 * value sets. The value is deeper than the key, and the first line that
 * belongs to it sets the indentation of the rest.
 */
function valueLines(lines, start, keyColumn) {
  const content = [];
  let indent = null;
  let end = start + 1;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.text.trim() === '') {
      content.push(line);
      end = index + 1;
      continue;
    }
    const width = indentWidth(line.text);
    if (!belongsToValue(width, indent, keyColumn)) break;
    indent = indent ?? width;
    content.push(line);
    end = index + 1;
  }
  return { content, indent, end };
}

/**
 * Whether a line of a folded block starts a new logical line: it is deeper
 * than the block, the line before it was, or a blank line came between them.
 */
function breaksFold(deeper, literal, breaks) {
  return deeper || literal || breaks > 0;
}

/**
 * The logical lines of a folded block: a break between two lines folds into
 * a space, a blank line breaks the line, and a line that is deeper than the
 * block keeps the breaks around it.
 */
function foldedLines(content, indent) {
  const logical = [];
  let current = null;
  let breaks = 0;
  let literal = false;
  for (const line of content) {
    if (line.text.trim() === '') {
      breaks += 1;
      continue;
    }
    const deeper = indent !== null && indentWidth(line.text) > indent;
    if (current === null) {
      current = { text: line.text.trim(), number: line.number };
    } else if (breaksFold(deeper, literal, breaks)) {
      logical.push(current);
      current = { text: line.text.trim(), number: line.number };
    } else {
      current.text = `${current.text} ${line.text.trim()}`;
    }
    breaks = 0;
    literal = deeper;
  }
  if (current !== null) logical.push(current);
  return logical;
}

/** The value of a quoted scalar, without the quotes around it. */
function unquoteValue(text) {
  if (text.length < 2) return text;
  const quote = text[0];
  if (quote !== '"' && quote !== "'") return text;
  if (text[text.length - 1] !== quote) return text;
  const inner = text.slice(1, -1);
  if (quote === '"') return inner.replace(/\\(["\\])/g, '$1');
  return inner.replace(/''/g, "'");
}

/**
 * The lines of the scalar a run: key holds, and the line the next key starts
 * on. A literal block keeps one line per line, a folded block becomes one
 * line, and a value that continues on the lines below it is joined with them.
 */
function readRunScalar(lines, index, key) {
  const value = stripComment(key.value).trim();
  if (BLOCK_INDICATOR.test(value)) {
    const block = valueLines(lines, index, key.column);
    const folded = value.startsWith('>');
    return {
      lines: folded
        ? foldedLines(block.content, block.indent)
        : block.content.map((entry) => ({ text: entry.text, number: entry.number })),
      end: block.end,
    };
  }
  const continuation = valueLines(lines, index, key.column);
  const parts = [unquoteValue(value), ...continuation.content.map((entry) => entry.text.trim())];
  const text = parts.filter((part) => part !== '').join(' ');
  return { lines: [{ text, number: lines[index].number }], end: continuation.end };
}

/**
 * The place of a workflow file: the steps: list a line sits in and the
 * sequence item whose keys it holds.
 */
function workflowContext(lines) {
  return {
    stepsColumn: null,
    itemColumn: null,
    marker: null,
    hasSteps: lines.some((line) => line.text.trim() === 'steps:'),
  };
}

/**
 * The place of a line after it has been read: a line left of the steps: list
 * ends the list, and a line left of the item ends the item.
 */
function contextOfLine(line, context) {
  if (line.text.trim() === '') return context;
  const width = indentWidth(line.text);
  if (context.stepsColumn !== null && width <= context.stepsColumn) {
    context.stepsColumn = null;
  }
  if (context.marker !== null && width < context.marker) {
    context.marker = null;
    context.itemColumn = null;
  }
  if (line.text.trim() === 'steps:') context.stepsColumn = width;
  const item = listItemOf(line);
  if (item) {
    context.marker = item.marker;
    context.itemColumn = item.content;
  }
  return context;
}

/**
 * The lines of every run: scalar of a workflow file, with the number each
 * line carries. A literal block keeps one line per line, a folded block
 * becomes one line, and a value that continues on the lines below it is
 * joined with them.
 */
function runScalars(lines) {
  const scalars = [];
  const context = workflowContext(lines);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const key = runKeyOf(line);
    const place = contextOfLine(line, context);
    if (!key || !isStepRunKey(place, key)) {
      index += 1;
      continue;
    }
    const scalar = readRunScalar(lines, index, key);
    scalars.push(scalar.lines);
    index = scalar.end;
  }
  return scalars;
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
 * The logical lines of a run: scalar: a line that ends with a backslash
 * continues on the next one.
 */
function logicalLines(lines) {
  const logical = [];
  let buffer = null;
  let start = 0;
  for (const line of lines) {
    const text = stripComment(line.text);
    const continued = isContinued(text);
    const piece = continued ? trimContinuation(text) : text;
    if (buffer === null) {
      buffer = piece;
      start = line.number;
    } else {
      buffer = `${buffer} ${piece.trim()}`;
    }
    if (continued) continue;
    logical.push({ text: buffer, number: start });
    buffer = null;
  }
  if (buffer !== null) logical.push({ text: buffer, number: start });
  return logical;
}

/** The commands of one logical line. */
function commandsOfLine(line) {
  const commands = [];
  for (const part of splitCommands(line.text)) {
    const args = argumentsOf(part);
    if (args.length > 0) commands.push({ number: line.number, args });
  }
  return commands;
}

/**
 * The commands of a workflow file: every command of every run: scalar is a
 * command, and each one has to carry its own protection.
 */
export default function readWorkflowCommands(lines) {
  const commands = [];
  for (const scalar of runScalars(lines)) {
    for (const line of logicalLines(scalar)) {
      commands.push(...commandsOfLine(line));
    }
  }
  return commands;
}
