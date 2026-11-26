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
