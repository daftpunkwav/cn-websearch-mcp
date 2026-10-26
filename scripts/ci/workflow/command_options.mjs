/**
 * @file workflow/command_options
 * @description Read the options of a command the way the client reads them.
 *
 * Responsibilities:
 * - Read the value of an option, in either the `--option value` or the
 *   `--option=value` spelling
 * - Read a boolean flag, with the negated spelling switching it off again
 * - Read the name a command word runs under
 * - Read the scheme of an argument that carries a URL
 *
 * Constraints:
 * - The last occurrence of an option wins, because that is how the client
 *   reads it.
 */

/** The name a command word runs under, without the path in front of it. */
export function commandName(arg) {
  return arg.split(/[\\/]/).pop() ?? arg;
}

/**
 * The scheme of an argument that carries a URL, or an empty string when it
 * carries none.
 */
export function urlScheme(arg) {
  const at = arg.indexOf('://');
  return at <= 0 ? '' : arg.slice(0, at).toLowerCase();
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
