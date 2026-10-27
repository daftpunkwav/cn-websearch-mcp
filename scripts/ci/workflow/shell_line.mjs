/**
 * @file workflow/shell_line
 * @description Read the text of a shell line as the commands it runs.
 *
 * Responsibilities:
 * - Mark every character of a line with the quoting it sits in
 * - Cut the trailing comment off a line
 * - Split a line into the commands it chains
 * - Split a command into its arguments, without the quotes around them
 *
 * Constraints:
 * - This module reads text only. It knows nothing about workflow files and
 *   nothing about the policy that is applied to a command.
 * - A quoted value is one argument, even when it carries a space. A value
 *   that is quoted is a value the client reads whole, and a URL written
 *   inside a quoted script is a URL the gate has to see.
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
 * a value is not mistaken for one.
 */
export function* characters(text) {
  let quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
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
 * The words of a command: whitespace outside quotes separates them, so a
 * quoted value stays one word even when it carries a space.
 */
function* words(command) {
  let word = '';
  let started = false;
  for (const { char, quoted } of characters(command)) {
    if (!quoted && char.trim().length === 0) {
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
