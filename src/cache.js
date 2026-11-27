/**
 * Incremental results cache.
 *
 * A mutation audit is expensive because it runs the suite once per mutant. Re-running
 * it on a project where neither the source file nor its covering tests changed must
 * not pay that cost again — otherwise nobody runs it before a commit, which is when
 * the feedback matters.
 *
 * A cache entry is keyed by everything that can change the answer:
 *
 *   - the source file's bytes
 *   - the bytes of every covering test file
 *   - the exact runner command, profile and mutation cap
 *   - the cache format version (bumped when the mutation/judging logic changes)
 *
 * Stored under node_modules/.cache when it exists (already ignored by every project),
 * otherwise in the OS temp directory. Nothing is ever written into the repo root.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Bump when `mutationsFor`, `selectMutations` or the judging rules change: an old
 * entry would otherwise claim a score the current version would not produce.
 */
const CACHE_VERSION = 1;

/**
 * The published package version, mixed into every cache key.
 *
 * 0.2.0 changed the judging rules substantially while CACHE_VERSION stayed at 1,
 * so entries written by 0.1.x were reused and reported 0.1.x scores as if they
 * were this version's findings. The format version alone cannot catch that: it
 * only changes when someone remembers to bump it. The package version changes
 * every release by construction.
 *
 * Falls back to 'unknown' when package.json is not next to this module (a
 * checkout layout change, an install without files): keys still differ from any
 * known version, so nothing stale is ever reused.
 */
function packageVersion() {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Upper bound on stored entries; oldest entries are dropped first. */
const MAX_ENTRIES = 1000;

export function cacheFileFor(root) {
  if (existsSync(join(root, 'node_modules'))) {
    return join(root, 'node_modules', '.cache', 'crucible', 'results.json');
  }
  const id = createHash('sha256').update(root).digest('hex').slice(0, 16);
  return join(tmpdir(), 'crucible-cache', id, 'results.json');
}

/** A stable identity for one file's audit inputs. */
export function cacheKey({ source, testContents = [], command, profile, maxMutations }) {
  const hash = createHash('sha256');
  hash.update(`v${CACHE_VERSION}\0`);
  hash.update(`${packageVersion()}\0`);
  hash.update(`${profile}\0${maxMutations}\0${command}\0`);
  hash.update(source);
  for (const text of testContents) {
    hash.update('\0');
    hash.update(text);
  }
  return hash.digest('hex').slice(0, 32);
}

/** @returns {Promise<{ file: string|null, entries: Record<string, object> }>} */
export async function loadCache(root, { enabled = true } = {}) {
  if (!enabled) return { file: null, entries: {} };

  const file = cacheFileFor(root);
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    // The stored format version AND the package version must both match: keys
    // from a different release never hit anyway, but this check keeps the file
    // honest about what wrote it.
    if (parsed?.version !== CACHE_VERSION
      || parsed?.packageVersion !== packageVersion()
      || typeof parsed.entries !== 'object' || parsed.entries === null) {
      return { file, entries: {} };
    }
    return { file, entries: parsed.entries };
  } catch {
    return { file, entries: {} };
  }
}

/**
 * Persist the cache. Failure to write is never fatal: a cache is an optimisation,
 * and a read-only checkout must still get a report.
 */
export async function saveCache(cache) {
  if (!cache.file) return;
  const keys = Object.keys(cache.entries);
  if (keys.length > MAX_ENTRIES) {
    for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete cache.entries[key];
  }
  try {
    await mkdir(dirname(cache.file), { recursive: true });
    await writeFile(cache.file, JSON.stringify({
      version: CACHE_VERSION,
      packageVersion: packageVersion(),
      entries: cache.entries,
    }), 'utf8');
  } catch { /* optimisation only */ }
}

/**
 * The serialisable parts of an audit result.
 *
 * `results` is dropped: it repeats the mutation objects and carries run output that
 * is only useful while reporting. Survivors are kept because they become findings.
 */
export function cacheableResult(result) {
  return {
    file: result.file,
    total: result.total,
    available: result.available,
    killed: result.killed,
    survived: result.survived,
    errored: result.errored,
    skipped: result.skipped,
    skippedReason: result.skippedReason ?? null,
    score: result.score,
    survivors: result.survivors,
    results: [],
  };
}

/** Shape-check a cached entry so a corrupted cache can never be reported as fact. */
export function isUsableResult(result) {
  return Boolean(result)
    && typeof result === 'object'
    && Number.isInteger(result.killed)
    && Number.isInteger(result.survived)
    && Array.isArray(result.survivors)
    && (result.score === null || (typeof result.score === 'number' && result.score >= 0 && result.score <= 1));
}
