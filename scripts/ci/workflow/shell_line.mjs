/**
 * @file workflow/shell_line
 * @description Read the text of a shell line as the commands it runs.
 *
 * Responsibilities:
 * - Mark every character of a line with the quoting it sits in
 * - Cut the trailing comment off a line
 * - Split a line into the commands it chains
 * - Split a command into its arguments, without the quotes around them
 * - Read the commands a command substitution runs
 *
 * Constraints:
 * - This module reads text only. It knows nothing about workflow files and
 *   nothing about the policy that is applied to a command.
 * - A quoted value is one argument, even when it carries a space. A value
 *   that is quoted is a value the client reads whole, and a URL written
 *   inside a quoted script is a URL the gate has to see.
 * - A command substitution runs a command of its own, so the text it holds
 *   is read as the commands it runs. A substitution inside single quotes is
 *   text, because single quotes hold every character as it is written.
 */

/** The characters that open and close a quoted value. */
const QUOTE_CHARACTERS = new Set(['"', "'"]);

/**
 * The quoting of a character: whether it sits in a quoted value, and the
 * quote that is open after it.
 */
function quoting(quote, char) {
  if (quote !== '') {
    return { quoted: true, quote: quote === char ? '' : quote };
  }
  if (QUOTE_CHARACTERS.has(char)) return { quoted: true, quote: char };
  return { quoted: false, quote: '' };
}

/**
 * Every character of the text, with the quoting it sits in: a character
 * inside a quoted value is marked, so that a separator or a comment inside
 * a value is not mistaken for one. An escaped character is marked as well,
 * because a backslash holds the character behind it as it is written. The
 * quote that is open after the character comes with it, so that a reader can
 * tell a single-quoted value from a double-quoted one.
 */
export function* characters(text) {
  let quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\' && quote !== "'" && index + 1 < text.length) {
      yield {
        char, index, quoted: true, quote, escaped: true,
      };
      index += 1;
      yield {
        char: text[index], index, quoted: true, quote, escaped: true,
      };
      continue;
    }
    const state = quoting(quote, char);
    quote = state.quote;
    yield {
      char, index, quoted: state.quoted, quote, escaped: false,
    };
  }
}

/**
 * Whether the character is whitespace: a trimmed character is empty, and an
 * empty string is all a whitespace character leaves behind.
 */
function isWhitespace(char) {
  return char !== undefined && char.trim().length === 0;
}

/**
 * Whether a character starts a comment: it is a '#' outside quotes, at the
 * start of the line or behind a space.
 */
function startsComment(text, { char, index, quoted }) {
  if (quoted) return false;
  if (char !== '#') return false;
  if (index === 0) return true;
  return isWhitespace(text[index - 1]);
}

/**
 * The command with its comment removed: a '#' outside quotes starts one.
 */
export function stripComment(text) {
  for (const character of characters(text)) {
    if (startsComment(text, character)) return text.slice(0, character.index);
  }
  return text;
}

/** The value of an argument without the quotes around it. */
export function unquote(arg) {
  const first = arg[0];
  const last = arg[arg.length - 1];
  if (!QUOTE_CHARACTERS.has(first)) return arg;
  if (!QUOTE_CHARACTERS.has(last)) return arg;
  return arg.slice(1, -1);
}

/**
 * Whether the character sits in text the shell holds as it is written: an
 * escaped character and a single-quoted value are both literal.
 */
function isLiteral(quote, escaped) {
  return escaped || quote === "'";
}

/** Whether the character opens a command substitution. */
function opensSubstitution(char, text, index) {
  return char === '$' && text[index + 1] === '(';
}

/** Whether the character closes a command substitution. */
function closesSubstitution(char, depth) {
  return char === ')' && depth > 0;
}

/**
 * The ranges of the substitutions that sit between parentheses: the text
 * between the brackets of every `$(...)`.
 */
function parenthesisRanges(text) {
  const ranges = [];
  let depth = 0;
  let start = 0;
  for (const {
    char, index, quote, escaped,
  } of characters(text)) {
    if (isLiteral(quote, escaped)) continue;
    if (opensSubstitution(char, text, index)) {
      if (depth === 0) start = index + 2;
      depth += 1;
      continue;
    }
    if (!closesSubstitution(char, depth)) continue;
    depth -= 1;
    if (depth === 0) ranges.push({ start, end: index });
  }
  return ranges;
}

/**
 * The ranges of the substitutions that sit between backquotes: the text
 * between the backquotes of every backquoted command.
 */
function backquoteRanges(text) {
  const ranges = [];
  let open = -1;
  for (const {
    char, index, quote, escaped,
  } of characters(text)) {
    if (isLiteral(quote, escaped)) continue;
    if (char !== '`') continue;
    if (open === -1) {
      open = index;
      continue;
    }
    ranges.push({ start: open + 1, end: index });
    open = -1;
  }
  return ranges;
}

/** Whether the character at the index sits inside a command substitution. */
function substitutedAt(ranges, index) {
  return ranges.some((range) => index > range.start && index < range.end);
}

/**
 * The ranges of the command substitutions of a text: the text between the
 * brackets of every substitution, with the index it starts at and the index
 * it ends at. A substitution inside single quotes is text, because single
 * quotes hold every character as it is written; a substitution inside double
 * quotes is one, because double quotes still expand it.
 */
function substitutionRanges(text) {
  return [...parenthesisRanges(text), ...backquoteRanges(text)];
}

/**
 * The words of a command: whitespace outside quotes and outside a command
 * substitution separates them, so a quoted value and the text of a
 * substitution stay one word even when they carry a space.
 */
function* words(command) {
  const ranges = substitutionRanges(command);
  let word = '';
  let started = false;
  for (const { char, index, quoted } of characters(command)) {
    if (!quoted && !substitutedAt(ranges, index) && char.trim().length === 0) {
      if (started) {
        yield word;
        word = '';
        started = false;
      }
      continue;
    }
    word += char;
    started = true;
  }
  if (started) yield word;
}

/**
 * The arguments of a command: the quotes around a value are dropped, and a
 * quoted value stays one argument.
 */
export function argumentsOf(command) {
  const args = [];
  for (const word of words(command)) {
    args.push(unquote(word));
  }
  return args;
}

/** Whether a character separates two commands in a shell line. */
function isSeparator(char) {
  return char === ';' || char === '&' || char === '|';
}

/**
 * The commands in a shell line: `a && b` runs two commands, and each one
 * has to carry its own protection.
 */
export function splitCommands(text) {
  const parts = [];
  let current = '';
  for (const { char, quoted } of characters(text)) {
    if (quoted || !isSeparator(char)) {
      current += char;
      continue;
    }
    parts.push(current.trim());
    current = '';
  }
  parts.push(current.trim());
  return parts.filter((part) => part !== '');
}

/**
 * The commands the command substitutions of a text run: the text between the
 * brackets of every substitution, read as the commands it runs. A
 * substitution inside a substitution runs a command of its own too.
 */
export function substitutedCommands(text) {
  const commands = [];
  for (const range of substitutionRanges(text)) {
    const inner = text.slice(range.start, range.end);
    for (const part of splitCommands(inner)) {
      const args = argumentsOf(part);
      if (args.length > 0) commands.push(args);
    }
    commands.push(...substitutedCommands(inner));
  }
  return commands;
}
