/**
 * @file workflow/download_policy
 * @description Decide whether a download keeps its protections.
 *
 * Responsibilities:
 * - Report a URL that uses another protocol than HTTPS
 * - Report a URL whose scheme the gate cannot read
 * - Report a curl that does not pin its protocol, its TLS version or its
 *   redirect protocol
 * - Report a wget that may follow a redirect, or whose URL the gate cannot
 *   read
 * - Report a download that runs a client the gate does not know
 *
 * Constraints:
 * - The download clients the gate knows are curl and wget. A client it does
 *   not know is not a download the gate can check, so a URL the text of the
 *   command carries is only accepted next to a client the gate knows, or next
 *   to the program the command runs when that program reads the URL as a
 *   value.
 */

import {
  commandName, isUrlArgument, optionValue, urlMarkers,
} from './command_options.mjs';

// The download clients the gate knows, by the name they run under.
const CURL_NAMES = new Set(['curl', 'curl.exe']);
const WGET_NAMES = new Set(['wget', 'wget.exe']);
const KNOWN_CLIENTS = new Set([...CURL_NAMES, ...WGET_NAMES]);
// The programs the gate knows and that carry a URL as a value rather than as
// an artifact they fetch: a registry is a value the install reads, a source
// tree is a tree the client checks out, and a printed URL is a text.
const KNOWN_PROGRAMS = new Set([
  'npm', 'npm.cmd', 'npx', 'npx.cmd',
  'yarn', 'yarnpkg', 'pnpm', 'pnpm.cmd',
  'pip', 'pip3',
  'git',
  'echo', 'printf',
]);
// The only protocol list the policy accepts: HTTPS and nothing else.
const HTTPS_ONLY = '=https';
// The curl options that ask the client to follow a redirect.
const REDIRECT_OPTIONS = new Set(['--location', '--location-trusted']);
// The name of an environment variable in an assignment.
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// The opening of a command substitution.
const COMMAND_SUBSTITUTION = /[$`]\(/;

/** Whether the argument is a short option bundle that carries an 'L'. */
function isShortBundleWithRedirect(arg) {
  return /^-[A-Za-z]+$/.test(arg) && arg.includes('L');
}

/** Whether the argument asks the client to follow a redirect. */
function isRedirectOption(arg) {
  if (REDIRECT_OPTIONS.has(arg)) return true;
  if (arg.startsWith('--location-trusted=')) return true;
  return isShortBundleWithRedirect(arg);
}

/** Whether the command asks the client to follow redirects. */
export function followsRedirects(args) {
  return args.some((arg) => isRedirectOption(arg));
}

/**
 * Whether the argument asks for TLS 1.2 or later. A maximum version does
 * not ask for a minimum: `--tls-max` caps the version and still allows an
 * older one, so only the options that raise the floor count.
 */
function isTlsOption(arg) {
  return arg === '--tlsv1.2' || arg === '--tlsv1.3';
}

/** Whether the command asks for TLS 1.2 or later. */
export function pinsTls(args) {
  return args.some((arg) => isTlsOption(arg));
}

/** The transfers of a curl command: `--next` starts a new one. */
export function transfers(args) {
  const parts = [[]];
  for (const arg of args) {
    if (arg === '--next') parts.push([]);
    else parts[parts.length - 1].push(arg);
  }
  return parts;
}

/** Whether the curl reads its options from a file the gate cannot check. */
function readsOptionsFromFile(args) {
  return optionValue(args, '--config') !== '' || args.includes('-K');
}

/**
 * The arguments of a command that are a URL of their own. A URL that is
 * attached to an option is that option's value, and a URL that stands on its
 * own is a value the client fetches.
 */
function urlArguments(args) {
  return args.filter((arg) => isUrlArgument(arg));
}

/**
 * The URL a curl command fetches: the one it names, or the one its --url
 * names.
 */
function curlUrl(args) {
  const named = optionValue(args, '--url');
  if (named !== '') return [named];
  return urlArguments(args);
}

/** The violation of a redirect that may leave HTTPS. */
function redirectViolation(args) {
  if (!followsRedirects(args)) return null;
  if (optionValue(args, '--proto-redir') === HTTPS_ONLY) return null;
  return "curl follows redirects without --proto-redir '=https'";
}

/** The violation of one curl transfer, or null when it keeps its protections. */
export function curlTransferViolation(args) {
  if (optionValue(args, '--proto') !== HTTPS_ONLY) return "curl without --proto '=https'";
  if (readsOptionsFromFile(args)) return 'curl reads its options from a file the gate cannot check';
  if (!pinsTls(args)) return 'curl without --tlsv1.2';
  if (curlUrl(args).length === 0) return 'curl without a URL the gate cannot check';
  return redirectViolation(args);
}

/** The violation of a curl command, or null when it keeps its protections. */
export function curlViolation(args) {
  for (const transfer of transfers(args)) {
    const violation = curlTransferViolation(transfer);
    if (violation) return violation;
  }
  return null;
}

/** Whether the wget reads its URLs from a file the gate cannot check. */
function readsUrlsFromFile(args) {
  return args.some((arg) => arg.startsWith('--input-file'));
}

/** The violation of a wget command, or null when it keeps its protection. */
export function wgetViolation(args) {
  if (optionValue(args, '--max-redirect') !== '0') {
    return 'wget may follow redirects (--max-redirect=0 required)';
  }
  if (readsUrlsFromFile(args)) {
    return 'wget reads its URLs from a file the gate cannot check';
  }
  if (urlArguments(args).length === 0) {
    return 'wget without a URL the gate cannot check';
  }
  return null;
}

/**
 * Whether the argument is an environment assignment. An assignment that
 * carries a command substitution runs a command of its own, so it is not one.
 */
function isEnvAssignment(arg) {
  if (!ENV_ASSIGNMENT.test(arg)) return false;
  return !COMMAND_SUBSTITUTION.test(arg);
}

/**
 * The program a command runs: the first argument that is not an environment
 * assignment, under the name it runs with. A name behind the program is an
 * argument of that program and names no program of its own.
 */
function programOf(args) {
  for (const arg of args) {
    if (isEnvAssignment(arg)) continue;
    return commandName(arg);
  }
  return '';
}

/**
 * The violation of a download that runs a client the gate does not know, or
 * null when the program the command runs is one the gate knows.
 */
export function unknownClientViolation(args) {
  const program = programOf(args);
  if (KNOWN_CLIENTS.has(program)) return null;
  if (KNOWN_PROGRAMS.has(program)) return null;
  if (!args.some((arg) => urlMarkers(arg).length > 0)) return null;
  return `download with a client the gate cannot check (${args[0]}): use curl or wget`;
}

/** The violation of a download, or null when it keeps its protections. */
export function downloadViolation(args) {
  const program = programOf(args);
  if (CURL_NAMES.has(program)) return curlViolation(args);
  if (WGET_NAMES.has(program)) return wgetViolation(args);
  return unknownClientViolation(args);
}

/** The violation of a cleartext URL, or null when every URL is HTTPS. */
export function cleartextViolation(args) {
  for (const arg of args) {
    for (const marker of urlMarkers(arg)) {
      if (marker.scheme !== '' && marker.scheme !== 'https') {
        return `download over a protocol other than HTTPS (${arg})`;
      }
    }
  }
  return null;
}

/**
 * The violation of a URL whose scheme the gate cannot read, or null when
 * every URL in the command has a scheme the gate can read. A scheme that is
 * written in pieces has no scheme the gate can read, and a URL the gate
 * cannot read is a URL it cannot verify.
 */
export function unreadableUrlViolation(args) {
  for (const arg of args) {
    for (const marker of urlMarkers(arg)) {
      if (marker.scheme !== '') continue;
      return `a URL whose scheme the gate cannot read (${arg})`;
    }
  }
  return null;
}
