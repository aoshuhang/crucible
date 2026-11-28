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
 * Quote a word for the shell that `exec` will use.
 *
 * POSIX: single quotes are literal, so `$(…)` and backticks cannot execute. A
 * quote inside the value is spliced as `'\''`.
 *
 * Windows `cmd.exe`: single quotes are ordinary characters, so paths with
 * spaces must use double quotes. Double quotes were unsafe on POSIX for the
 * command-substitution reason above, but they are the correct Windows form.
 */
export function shQuote(word, platform = process.platform) {
  const s = String(word);
  const safe = /^[A-Za-z0-9_@%+=:,./\\-]+$/;
  if (safe.test(s)) return s;

  if (platform === 'win32') {
    if (s === '') return '""';
    // Windows file names cannot contain `"`, but command arguments can.
    return `"${s.replace(/"/g, '\\"')}"`;
  }

  if (s === '') return "''";
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
