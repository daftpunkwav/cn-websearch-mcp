/**
 * @file workflow/download_policy
 * @description Decide whether a download keeps its protections.
 *
 * Responsibilities:
 * - Report a URL that uses another protocol than HTTPS
 * - Report a curl that does not pin its protocol, its TLS version or its
 *   redirect protocol
 * - Report a wget that may follow a redirect, or whose URL the gate cannot
 *   read
 *
 * Constraints:
 * - The download clients the gate knows are curl and wget. A client it does
 *   not know is not a download the gate can check.
 */

import { commandName, optionValue, urlScheme } from './command_options.mjs';

// The download clients the gate knows, by the name they run under.
const CURL_NAMES = new Set(['curl', 'curl.exe']);
const WGET_NAMES = new Set(['wget', 'wget.exe']);
// The only protocol list the policy accepts: HTTPS and nothing else.
const HTTPS_ONLY = '=https';
// The curl options that ask the client to follow a redirect.
const REDIRECT_OPTIONS = new Set(['--location', '--location-trusted']);

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

/** Whether the wget has a URL the gate can read. */
function hasUrl(args) {
  return args.some((arg) => urlScheme(arg) !== '');
}

/** The violation of a wget command, or null when it keeps its protection. */
export function wgetViolation(args) {
  if (optionValue(args, '--max-redirect') !== '0') {
    return 'wget may follow redirects (--max-redirect=0 required)';
  }
  if (readsUrlsFromFile(args)) {
    return 'wget reads its URLs from a file the gate cannot check';
  }
  if (!hasUrl(args)) {
    return 'wget without a URL the gate cannot check';
  }
  return null;
}

/** Whether the command runs one of the given clients. */
function runsClient(args, names) {
  return args.some((arg) => names.has(commandName(arg)));
}

/** The violation of a download, or null when it keeps its protections. */
export function downloadViolation(args) {
  if (runsClient(args, CURL_NAMES)) return curlViolation(args);
  if (runsClient(args, WGET_NAMES)) return wgetViolation(args);
  return null;
}

/** The violation of a cleartext URL, or null when every URL is HTTPS. */
export function cleartextViolation(args) {
  for (const arg of args) {
    const scheme = urlScheme(arg);
    if (scheme && scheme !== 'https') {
      return `download over a protocol other than HTTPS (${arg})`;
    }
  }
  return null;
}
