import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, rm, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { discover } from '../src/discover.js';
import { baseline, auditFile } from '../src/judge.js';
import { fixBoundaries } from '../src/fix-boundary.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/project/', import.meta.url));

/**
 * The end-to-end claim this product makes: a fake test scores low, and after the
 * fix the score goes up and the suite is still green.
 *
 * This test runs the real thing on a copy of the fixture. It is the only test that
 * proves the tool does what the README says.
 */
test('fix raises the mutation score on a project with a fake test', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-e2e-'));
  await cp(FIXTURE, dir, { recursive: true });

  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  // Remove any generated file that shipped with the fixture so we start clean.
  await rm(join(dir, 'tests/limits.exact.test.js'), { force: true });

  const project = await discover(dir);
  assert.ok(project.runner, 'fixture must expose a test runner');

  const base = await baseline({ root: project.root, command: project.runner.command });
  assert.equal(base.green, true, 'fixture suite must start green');

  const [sourceFile, testFiles] = [...project.covers.entries()].find(([, tests]) => tests.length > 0);

  const before = await auditFile({
    root: project.root,
    file: sourceFile,
    command: project.runner.command,
    maxMutations: 12,
  });
  assert.ok(before.score !== null, 'audit must produce a score');
  assert.ok(before.score < 0.5, `fake test should score low, got ${before.score}`);

  const fix = await fixBoundaries({
    root: project.root,
    sourceFile,
    testFiles,
    runner: project.runner.command,
    runnerName: project.runner.name,
  });
  assert.ok(fix.written, `expected a written test, got: ${fix.reason}`);

  const afterFix = await baseline({ root: project.root, command: project.runner.command });
  assert.equal(afterFix.green, true, 'suite must still be green after the fix');

  const after = await auditFile({
    root: project.root,
    file: sourceFile,
    command: project.runner.command,
    maxMutations: 12,
  });
  assert.ok(after.score > before.score, `score should improve: ${before.score} -> ${after.score}`);
});

test('generated boundary test calls at the threshold and its neighbours', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-gen-'));
  await cp(FIXTURE, dir, { recursive: true });
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  await rm(join(dir, 'tests/limits.exact.test.js'), { force: true });

  const project = await discover(dir);
  const [sourceFile, testFiles] = [...project.covers.entries()].find(([, tests]) => tests.length > 0);

  const fix = await fixBoundaries({
    root: project.root,
    sourceFile,
    testFiles,
    runner: project.runner.command,
    runnerName: project.runner.name,
  });

  assert.ok(fix.written);
  const body = await readFile(fix.written, 'utf8');

  // MAX is 10, so the three probe points must be 9, 10 and 11.
  assert.match(body, /\(9\)/, 'must probe one below the threshold');
  assert.match(body, /\(10\)/, 'must probe exactly at the threshold');
  assert.match(body, /\(11\)/, 'must probe one above the threshold');
});

test('the working tree is restored after an audit', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-restore-'));
  await cp(FIXTURE, dir, { recursive: true });
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const project = await discover(dir);
  const [sourceFile] = [...project.covers.entries()].find(([, tests]) => tests.length > 0);
  const before = await readFile(sourceFile, 'utf8');

  await auditFile({
    root: project.root,
    file: sourceFile,
    command: project.runner.command,
    maxMutations: 4,
  });

  const after = await readFile(sourceFile, 'utf8');
  assert.equal(after, before, 'source must be byte-identical after mutating');
});
