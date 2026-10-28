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
// The depth of the substitutions the reader follows: a run scalar that nests
// them deeper than this is read as far as the limit reaches.
const MAX_SUBSTITUTION_DEPTH = 100;

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
 * Whether the character at the index escapes the character behind it. A
 * backslash inside single quotes is a backslash, and a backslash at the end
 * of the text escapes nothing.
 */
function isEscape(text, index, quote) {
  if (text[index] !== '\\') return false;
  if (quote === "'") return false;
  return index + 1 < text.length;
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
    if (isEscape(text, index, quote)) {
      yield { char, index, quoted: true };
      index += 1;
      yield { char: text[index], index, quoted: true };
      continue;
    }
    const state = quoting(quote, char);
    quote = state.quote;
    yield { char, index, quoted: state.quoted };
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
 * The quote that is open after the character: a quote opens a value and its
 * closing quote ends it. A single-quoted value holds every character as it
 * is written, so nothing in it is expanded.
 */
function quoteAfter(quote, char) {
  if (quote === "'") return char === "'" ? '' : "'";
  if (quote === '"') return char === '"' ? '' : '"';
  return char === '"' || char === "'" ? char : '';
}

/** Whether the character opens a command substitution. */
function opensSubstitution(char, text, index) {
  return char === '$' && text[index + 1] === '(';
}

/**
 * The index of the parenthesis that closes the command substitution that
 * opens at the given index, or -1 when the text holds no closing
 * parenthesis. The text of a substitution is read on its own, because the
 * quoting inside it belongs to it and not to the text around it.
 */
function closingSubstitution(text, start) {
  let depth = 1;
  for (const { char, index, quoted } of characters(text.slice(start))) {
    if (quoted) continue;
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char !== ')') continue;
    depth -= 1;
    if (depth === 0) return start + index;
  }
  return -1;
}

/**
 * The range of the substitution that starts at the given index, or null when
 * no substitution starts there.
 */
function substitutionAt(text, index, char) {
  if (opensSubstitution(char, text, index)) {
    const close = closingSubstitution(text, index + 2);
    return close === -1 ? null : { start: index + 2, end: close };
  }
  if (char !== '`') return null;
  const close = text.indexOf('`', index + 1);
  return close === -1 ? null : { start: index + 1, end: close };
}

/**
 * The ranges of the command substitutions of a text: the text between the
 * brackets of every `$(...)` and between the backquotes of every backquoted
 * command. The text of a substitution is read on its own, so a nested
 * substitution is read with the quote state that begins inside the one that
 * holds it.
 */
function substitutionRanges(text) {
  const ranges = [];
  let quote = '';
  let index = 0;
  while (index < text.length) {
    if (isEscape(text, index, quote)) {
      index += 2;
      continue;
    }
    const char = text[index];
    const literal = quote === "'";
    quote = quoteAfter(quote, char);
    if (literal) {
      index += 1;
      continue;
    }
    const range = substitutionAt(text, index, char);
    if (range === null) {
      index += 1;
      continue;
    }
    ranges.push(range);
    index = range.end + 1;
  }
  return ranges;
}

/** Whether the character at the index sits inside a command substitution. */
function substitutedAt(ranges, index) {
  return ranges.some((range) => index > range.start && index < range.end);
}

/**
 * Whether the character separates two words of a command: a whitespace
 * character outside quotes and outside a command substitution does.
 */
function separatesWords(char, quoted, substituted) {
  if (quoted) return false;
  if (substituted) return false;
  return isWhitespace(char);
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
    if (separatesWords(char, quoted, substitutedAt(ranges, index))) {
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
export function substitutedCommands(text, level = 0) {
  const commands = [];
  if (level > MAX_SUBSTITUTION_DEPTH) return commands;
  for (const range of substitutionRanges(text)) {
    const inner = text.slice(range.start, range.end);
    for (const part of splitCommands(inner)) {
      const args = argumentsOf(part);
      if (args.length > 0) commands.push(args);
    }
    commands.push(...substitutedCommands(inner, level + 1));
  }
  return commands;
}
