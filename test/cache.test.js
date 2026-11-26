import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  cacheFileFor, cacheKey, loadCache, saveCache, cacheableResult, isUsableResult,
} from '../src/cache.js';

async function projectDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-cache-'));
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const base = {
  source: 'export const x = 1;\n',
  testContents: ['assert.equal(x, 1);\n'],
  command: './node_modules/.bin/vitest run',
  profile: 'logic',
  maxMutations: 12,
};

test('the cache key changes when any input changes', () => {
  const key = cacheKey(base);

  assert.equal(cacheKey({ ...base }), key, 'same inputs must hash the same');
  assert.notEqual(cacheKey({ ...base, source: 'export const x = 2;\n' }), key);
  assert.notEqual(cacheKey({ ...base, testContents: ['assert.equal(x, 2);\n'] }), key);
  assert.notEqual(cacheKey({ ...base, command: './node_modules/.bin/jest --ci' }), key);
  assert.notEqual(cacheKey({ ...base, profile: 'strict' }), key);
  assert.notEqual(cacheKey({ ...base, maxMutations: 6 }), key);
});

test('the cache lives under node_modules when it exists', async (t) => {
  const dir = await projectDir(t);
  assert.equal(cacheFileFor(dir), join(dir, 'node_modules', '.cache', 'crucible', 'results.json'));
});

test('entries survive a save and load round trip', async (t) => {
  const dir = await projectDir(t);
  const key = cacheKey(base);

  const cache = await loadCache(dir);
  cache.entries[key] = { killed: 1, survived: 0, score: 1, survivors: [] };
  await saveCache(cache);

  const reloaded = await loadCache(dir);
  assert.deepEqual(reloaded.entries[key], cache.entries[key]);

  // The file really is JSON on disk, not an in-memory illusion.
  const raw = JSON.parse(await readFile(reloaded.file, 'utf8'));
  assert.ok(raw.entries[key]);
});

test('a cache written by another format version is ignored', async (t) => {
  const dir = await projectDir(t);
  const file = cacheFileFor(dir);
  await mkdir(join(dir, 'node_modules', '.cache', 'crucible'), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 999, entries: { any: { killed: 99 } } }), 'utf8');

  const cache = await loadCache(dir);
  assert.deepEqual(cache.entries, {}, 'a stale format must not be reported as fact');
});

test('--no-cache style loading returns no entries', async (t) => {
  const dir = await projectDir(t);
  const cache = await loadCache(dir, { enabled: false });
  assert.equal(cache.file, null);
  assert.deepEqual(cache.entries, {});
});

test('corrupt entries are rejected by the usability check', () => {
  assert.equal(isUsableResult(null), false);
  assert.equal(isUsableResult({ killed: '1' }), false);
  assert.equal(isUsableResult({ killed: 1, survived: 1, survivors: [], score: 2 }), false);
  assert.equal(isUsableResult({ killed: 1, survived: 1, survivors: [], score: 0.5 }), true);
  assert.equal(isUsableResult({ killed: 0, survived: 0, survivors: [], score: null }), true);
});

test('the cached result keeps what findings need and drops run output', () => {
  const stored = cacheableResult({
    file: '/p/a.js',
    total: 12,
    available: 20,
    killed: 3,
    survived: 9,
    errored: 0,
    skipped: 0,
    score: 0.25,
    survivors: [{ mutation: { line: 3 }, verdict: 'SURVIVED' }],
    results: [{ output: 'x'.repeat(2000) }],
  });

  assert.equal(stored.killed, 3);
  assert.equal(stored.survivors.length, 1);
  assert.deepEqual(stored.results, []);
  assert.equal(isUsableResult(stored), true);
});
