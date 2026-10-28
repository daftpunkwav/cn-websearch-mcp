/**
 * @file workflow/workflow_lines
 * @description Read the run: scalars of a workflow file as the commands they run.
 *
 * Responsibilities:
 * - Find the run: key of every step of a workflow file
 * - Read a step whose item is a flow mapping: find the run: entry of the
 *   mapping and read its value the way the block form is read
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
 * - A run: key with no value of its own holds a nested mapping or a sequence
 *   when the line below it starts one, and a plain scalar otherwise.
 * - A flow mapping is read on the line it starts. The value of its run:
 *   entry ends at the comma or the brace that closes the entry, and a
 *   quoted value ends at its closing quote.
 */

import {
  argumentsOf, characters, splitCommands, stripComment, substitutedCommands,
} from './shell_line.mjs';

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
 * Whether the line starts a mapping key: a colon outside quotes that is
 * followed by whitespace or by the end of the line. A plain scalar cannot
 * carry such a colon, so a line that holds one is a key and its value. The
 * comment of the line is no part of it, so a colon in a comment names no key.
 */
function startsMappingKey(line) {
  if (line === null) return false;
  const text = stripComment(line.text);
  for (const { char, index, quoted } of characters(text)) {
    if (quoted || char !== ':') continue;
    const next = text[index + 1];
    if (next === undefined || next.trim() === '') return true;
  }
  return false;
}

/**
 * Whether the line below a key with no value holds a plain scalar: it starts
 * no mapping key and no sequence item. A line that starts neither is a value
 * of its own kind, and the key holds a mapping or a sequence then.
 */
function holdsPlainScalar(line) {
  if (line === null) return false;
  if (startsMappingKey(line)) return false;
  return listItemOf(line) === null;
}

/**
 * The next line that carries content, or null when no line follows.
 */
function nextContentLine(lines, index) {
  for (let next = index + 1; next < lines.length; next += 1) {
    if (lines[next].text.trim() !== '') return lines[next];
  }
  return null;
}

/**
 * Whether the line holds the run: key of a step. A key with no value holds a
 * nested mapping or a sequence when the line below it starts one, and a plain
 * scalar otherwise. A key outside the steps: list of a job belongs to another
 * mapping, and a key deeper than the keys of its item belongs to a nested
 * mapping of the step.
 */
function isStepRunKey(context, key, nextContent) {
  if (key.value.trim() === '' && !holdsPlainScalar(nextContent)) return false;
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

/** Whether the character is the whitespace a flow mapping may carry. */
function isFlowSpace(char) {
  return char === ' ' || char === '\t';
}

/** Whether the character opens a quoted value. */
function isFlowQuote(char) {
  return char === '"' || char === "'";
}

/** Whether the character opens a structure nested in the flow mapping. */
function opensFlow(char) {
  return char === '{' || char === '[';
}

/** Whether the character closes a structure nested in the flow mapping. */
function closesFlow(char) {
  return char === '}' || char === ']';
}

/** Whether the character is one of the marks a flow entry is built from. */
function isFlowStructure(char) {
  return opensFlow(char) || closesFlow(char) || char === ':' || char === ',';
}

/**
 * The index behind the closing quote of the quoted value that starts at the
 * given index. A backslash in a double-quoted value holds the character
 * behind it as it is written, and two single quotes hold a single one. A
 * value with no closing quote runs to the end of the text.
 */
function closingQuoteOf(text, start) {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (quote === '"' && char === '\\') {
      index += 2;
      continue;
    }
    if (char !== quote) {
      index += 1;
      continue;
    }
    if (quote === "'" && text[index + 1] === "'") {
      index += 2;
      continue;
    }
    return index + 1;
  }
  return text.length;
}

/**
 * The place a plain flow value ends: the comma or the brace that closes the
 * entry, or the end of the text.
 */
function plainFlowValueEnd(text, start) {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === ',' || text[index] === '}') return index;
  }
  return text.length;
}

/**
 * The value of a flow entry, cut where the entry ends: a quoted value ends
 * at its closing quote, and a plain value at the comma or the brace that
 * closes the entry.
 */
function flowValueAfter(text, start) {
  let index = start;
  while (index < text.length && isFlowSpace(text[index])) index += 1;
  if (isFlowQuote(text[index])) {
    return unquoteValue(text.slice(index, closingQuoteOf(text, index)));
  }
  return text.slice(index, plainFlowValueEnd(text, index)).trim();
}

/**
 * The places the entries of the flow mapping that starts at the given index
 * are cut at: every comma of the body and the brace that closes the
 * mapping, or null when the mapping is not wholly on the line. A quoted
 * span or a structure nested in the body belongs to the entry that carries
 * it, so a comma inside either cuts no entry. A quote opens a span where an
 * entry or a value starts, so an apostrophe inside a plain value stays a
 * character of the value.
 */
function flowEntryCuts(text, start) {
  const cuts = [];
  let depth = 0;
  let boundary = false;
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (isFlowSpace(char)) {
      index += 1;
      continue;
    }
    if (isFlowQuote(char) && boundary) {
      index = closingQuoteOf(text, index);
      boundary = false;
      continue;
    }
    if (closesFlow(char) && depth === 1) {
      return [...cuts, index];
    }
    if (opensFlow(char)) {
      depth += 1;
    } else if (closesFlow(char)) {
      depth -= 1;
    }
    boundary = isFlowStructure(char);
    index += 1;
  }
  return null;
}

/**
 * The entries of the flow mapping that starts at the given index, as the
 * text of each one, or null when the mapping is not wholly on the line.
 */
function flowEntryTexts(text, start) {
  const cuts = flowEntryCuts(text, start);
  if (cuts === null) return null;
  const entries = [];
  let entry = start + 1;
  for (const cut of cuts) {
    entries.push(text.slice(entry, cut));
    entry = cut + 1;
  }
  return entries;
}

/**
 * The value of the run: entry of the flow mapping that starts at the given
 * index, or null when the mapping carries no run: entry of its own. Only
 * the first colon of an entry separates its key from its value, so an entry
 * of a mapping nested in the body belongs to another key and never matches.
 */
function flowRunValueAt(text, start) {
  const entries = flowEntryTexts(text, start);
  if (entries === null) return null;
  for (const entry of entries) {
    const colon = entry.indexOf(':');
    if (colon === -1) continue;
    if (entry.slice(0, colon).trim() === 'run') return flowValueAfter(entry, colon + 1);
  }
  return null;
}

/**
 * The value of the run: entry of a step written as a flow mapping, or null
 * when the line starts no such step. The item of the steps: list carries the
 * mapping, and a mapping outside the steps: list of a workflow holds no
 * command.
 */
function flowStepRunValue(line, context) {
  if (context.stepsColumn === null && context.hasSteps) return null;
  const item = listItemOf(line);
  if (item === null) return null;
  return flowRunValueAt(line.text, item.content);
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
  const parts = [value, ...continuation.content
    .filter((entry) => stripComment(entry.text).trim() !== '')
    .map((entry) => entry.text.trim())];
  const text = unquoteValue(parts.filter((part) => part !== '').join(' '));
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
    hasSteps: lines.some((line) => stripComment(line.text).trim() === 'steps:'),
  };
}

/**
 * Whether the line leaves the steps: list: it is left of the list, or it sits
 * at the column of the list and starts no item.
 */
function leavesStepsList(context, width, item) {
  if (context.stepsColumn === null) return false;
  if (width < context.stepsColumn) return true;
  return width === context.stepsColumn && item === null;
}

/**
 * The place of a line after it has been read: a line left of the steps: list
 * ends the list, and a line left of the item ends the item. A sequence may
 * start at the column of the key it belongs to, so a line at that column
 * ends the list only when it starts no item.
 */
function contextOfLine(line, context) {
  if (line.text.trim() === '') return context;
  const width = indentWidth(line.text);
  const item = listItemOf(line);
  if (leavesStepsList(context, width, item)) context.stepsColumn = null;
  if (context.marker !== null && width < context.marker) {
    context.marker = null;
    context.itemColumn = null;
  }
  if (stripComment(line.text).trim() === 'steps:') context.stepsColumn = width;
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
 * joined with them. A step written as a flow mapping holds its value on the
 * line the item starts.
 */
function runScalars(lines) {
  const scalars = [];
  const context = workflowContext(lines);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const key = runKeyOf(line);
    const place = contextOfLine(line, context);
    if (key && isStepRunKey(place, key, nextContentLine(lines, index))) {
      const scalar = readRunScalar(lines, index, key);
      scalars.push(scalar.lines);
      index = scalar.end;
      continue;
    }
    const flow = flowStepRunValue(line, place);
    if (flow !== null) scalars.push([{ text: flow, number: line.number }]);
    index += 1;
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
  for (const args of substitutedCommands(line.text)) {
    commands.push({ number: line.number, args });
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
