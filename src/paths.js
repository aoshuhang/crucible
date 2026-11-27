/**
 * Path helpers that behave the same everywhere.
 *
 * The first version assumed `/` everywhere: `file.split('/').pop()` for a basename
 * and `file.replace(root + '/', '')` for a relative path. Both are wrong on Windows,
 * where paths use `\` — split returns the whole string and replace matches nothing,
 * so reports would show absolute Windows paths as "file names".
 *
 * Everything user-visible goes through these.
 */

import { relative, basename as pathBasename } from 'node:path';

/** Forward slashes, always. */
export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/** Path relative to root, with forward slashes. `''` when identical. */
export function relPosix(root, file) {
  return toPosix(relative(root, file));
}

/** File name without directories, correct on every platform. */
export function baseName(file) {
  return pathBasename(String(file));
}

/** File name without directories and without extension. */
export function stem(file) {
  return baseName(file).replace(/\.[^.]+$/, '');
}

/**
 * Is this an absolute path on the current platform?
 * Used to decide whether a test file needs to be made relative before handing it to
 * a shell command.
 */
export function isAbsolutePath(p) {
  return /^([A-Za-z]:[\\/]|[\\/])/.test(String(p));
}

/**
 * The neighbouring comparison operator, for readable report text.
 *
 * Defined once here: it was duplicated in three places (boundary, fix, the CLI)
 * and they could drift.
 */
export const NEIGHBOUR_OPERATOR = {
  '<': '<=', '<=': '<', '>': '>=', '>=': '>',
  '===': '!==', '!==': '===', '==': '!=', '!=': '==',
};

/**
 * Quote a word for a POSIX shell.
 *
 * `JSON.stringify` was used here before, which produces DOUBLE quotes — and
 * inside double quotes the shell still expands `$(…)`, backticks and `\`. A test
 * file named `$(touch pwned).test.js` would execute its name. Single quotes are
 * literal in POSIX sh; a single quote inside the value is spliced as `'\''`.
 *
 * These commands run through `exec(command, shell)` on the user's machine, so
 * the quoting must hold for bash, zsh, dash and /bin/sh alike.
 */
export function shQuote(word) {
  const s = String(word);
  if (s === '') return "''";
  // Nothing metacharacter-ish can appear: keep it readable.
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
