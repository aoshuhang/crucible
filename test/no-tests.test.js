import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discover } from '../src/discover.js';

/**
 * "Nothing to report" and "I could not find your tests" are different answers and
 * must not look the same. A Java project with no recognised tests used to get the
 * all-clear.
 */

test('a project with source but no recognised tests reports zero tests', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-java-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'src/main/java'), { recursive: true });
  await writeFile(join(dir, 'src/main/java/A.java'), 'public class A {}\n');
  await writeFile(join(dir, 'build.gradle'), 'plugins { id "java" }\n');

  const p = await discover(dir);
  assert.equal(p.testFiles.length, 0, 'no test was found');
  assert.equal(p.sourceFiles.length, 1, 'but source was');
});

test('an empty directory has neither', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-empty-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const p = await discover(dir);
  assert.equal(p.testFiles.length, 0);
  assert.equal(p.sourceFiles.length, 0);
});

test('a project whose tests do follow a convention is not affected', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-ok-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src/a.js'), 'export const a = 1;\n');
  await writeFile(join(dir, 'src/a.test.js'), "it('x', () => {});\n");

  const p = await discover(dir);
  assert.equal(p.testFiles.length, 1);
});
