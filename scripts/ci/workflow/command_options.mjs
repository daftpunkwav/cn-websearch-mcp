/**
 * @file workflow/command_options
 * @description Read the options of a command the way the client reads them.
 *
 * Responsibilities:
 * - Read the value of an option, in either the `--option value` or the
 *   `--option=value` spelling
 * - Read a boolean flag, with the negated spelling switching it off again
 * - Read the name a command word runs under
 * - Read the URLs an argument carries and the scheme of each one
 *
 * Constraints:
 * - The last occurrence of an option wins, because that is how the client
 *   reads it.
 * - The scheme of a URL is the run of scheme characters that ends at its
 *   `://`. A URL whose scheme is written in pieces has no scheme the gate
 *   can read, and a scheme the gate cannot read is not a scheme at all.
 */

/** Whether a character may hold in a URL scheme, per RFC 3986. */
const SCHEME_CHARACTER = /[A-Za-z0-9+.-]/;

/**
 * The command word of an argument: the word between the brackets of a command
 * substitution, or the argument itself.
 */
function commandWordOf(arg) {
  const open = arg.search(/[$`]\(/);
  if (open === -1) return arg;
  const inner = arg.slice(open + 2);
  const close = inner.search(/[)`]/);
  const word = close === -1 ? inner : inner.slice(0, close);
  return word.split(/\s+/)[0];
}

/**
 * The name a command word runs under, without the path in front of it. A
 * command substitution carries the command word between its brackets, so the
 * word of the substituted command is the name the client runs under.
 */
export function commandName(arg) {
  const bare = commandWordOf(arg);
  return bare.split(/[\\/]/).pop() ?? bare;
}

/**
 * The scheme that ends at the `://` of a URL, or an empty string when the
 * gate cannot read one. The scheme is the run of scheme characters that ends
 * at the URL, so a URL whose scheme is written in pieces has none.
 */
function schemeBefore(arg, at) {
  let start = at;
  while (start > 0 && SCHEME_CHARACTER.test(arg[start - 1])) start -= 1;
  if (start === at) return '';
  return arg.slice(start, at).toLowerCase();
}

/**
 * The URL markers of an argument: every `://` it carries, with the scheme
 * that ends at it. A marker without a scheme belongs to a URL whose scheme
 * is written in pieces.
 */
export function urlMarkers(arg) {
  const markers = [];
  let from = 0;
  for (;;) {
    const at = arg.indexOf('://', from);
    if (at === -1) return markers;
    markers.push({ at, scheme: schemeBefore(arg, at) });
    from = at + 3;
  }
}

/**
 * The scheme of an argument that carries a URL, or an empty string when it
 * carries none.
 */
function urlScheme(arg) {
  const marker = urlMarkers(arg)[0];
  return marker ? marker.scheme : '';
}

/**
 * Whether the argument is a URL of its own: it starts with a scheme the gate
 * can read.
 */
export function isUrlArgument(arg) {
  return urlScheme(arg) !== '' && /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(arg);
}

/** Whether the argument is the option with its value attached. */
function isAttachedValue(arg, name) {
  return arg.startsWith(`${name}=`);
}

/**
 * The value of the last occurrence of an option, in either the
 * `--option value` or the `--option=value` spelling. The last occurrence
 * wins, because that is how the client reads it. An option that is not
 * there reads as an empty value.
 */
export function optionValue(args, name) {
  let value = '';
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === name) {
      value = args[i + 1] ?? '';
      i += 1;
    } else if (isAttachedValue(arg, name)) {
      value = arg.slice(name.length + 1);
    }
  }
  return value;
}

/**
 * Whether a boolean flag is set. The last occurrence decides, so
 * `--ignore-scripts=false` and `--no-ignore-scripts` switch it off again.
 */
export function flagEnabled(args, name) {
  const negated = `--no-${name.slice(2)}`;
  let enabled = false;
  for (const arg of args) {
    if (arg === name) enabled = true;
    else if (arg === negated) enabled = false;
    else if (isAttachedValue(arg, name)) enabled = arg.slice(name.length + 1) !== 'false';
  }
  return enabled;
}
