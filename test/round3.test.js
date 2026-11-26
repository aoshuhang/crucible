import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discover } from '../src/discover.js';
import { addFailFast, narrowCommand } from '../src/judge.js';

/**
 * Third round of hunting: pnpm monorepos, projects with no node_modules, and the
 * performance of a 424-test suite.
 */

async function project(pkg, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-r3-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  await writeFile(join(dir, 'src/index.js'), 'export const a = 1;\n');
  for (const [name, body] of Object.entries(extra)) {
    await writeFile(join(dir, name), body);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Package manager detection.
// ---------------------------------------------------------------------------

test('detects pnpm from its lockfile', async (t) => {
  const dir = await project({ name: 'x', scripts: { test: 'ava' } }, { 'pnpm-lock.yaml': 'lockfileVersion: 9\n' });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const p = await discover(dir);
  assert.equal(p.packageManager, 'pnpm', 'the install hint must say pnpm install, not npm');
});

test('detects yarn and bun', async (t) => {
  const y = await project({ name: 'y', scripts: { test: 'ava' } }, { 'yarn.lock': '' });
  const b = await project({ name: 'b', scripts: { test: 'ava' } }, { 'bun.lockb': '' });
  t.after(async () => {
    await rm(y, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  });

  assert.equal((await discover(y)).packageManager, 'yarn');
  assert.equal((await discover(b)).packageManager, 'bun');
});

test('defaults to npm without a lockfile', async (t) => {
  const dir = await project({ name: 'x', scripts: { test: 'ava' } });
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.equal((await discover(dir)).packageManager, 'npm');
});

// ---------------------------------------------------------------------------
// A declared but uninstalled runner must be reported, not worked around.
// ---------------------------------------------------------------------------

test('a declared but uninstalled vitest is marked as not installed', async (t) => {
  const dir = await project({
    name: 'x',
    devDependencies: { vitest: '^1.0.0' },
    scripts: { test: 'vitest run' },
  });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const p = await discover(dir);
  assert.equal(p.runner.installed, false);
  // It must point at the local path. Falling back to npx would run a cached vitest
  // against this project's code and report a version-mismatch crash as a red suite.
  assert.match(p.runner.command, /node_modules\/\.bin\/vitest/);
  assert.ok(!/npx/.test(p.runner.command), 'npx must never appear in a runner command');
});

// ---------------------------------------------------------------------------
// Fail-fast flags.
// ---------------------------------------------------------------------------

test('vitest and jest get --bail=1', () => {
  assert.match(addFailFast('./node_modules/.bin/vitest run'), /--bail=1/);
  assert.match(addFailFast('./node_modules/.bin/jest --ci'), /--bail=1/);
});

test('ava gets --fail-fast', () => {
  assert.match(addFailFast('./node_modules/.bin/ava'), /--fail-fast/);
});

test('pytest keeps -x and is not given a second one', () => {
  assert.equal(addFailFast('python3 -m pytest -x -q'), 'python3 -m pytest -x -q');
  assert.match(addFailFast('python3 -m pytest -q'), /-x/);
});

test('go test gets -failfast but cargo test does not', () => {
  // "cargo test" contains the substring "go test"; without a word boundary cargo
  // was handed Go's flag and the command would error.
  assert.match(addFailFast('go test ./...'), /-failfast/);
  assert.equal(addFailFast('cargo test --quiet'), 'cargo test --quiet');
  assert.equal(addFailFast('cargo test'), 'cargo test');
});

test('node --test is left alone because it has no bail flag', () => {
  assert.equal(addFailFast("node --test 'test/*.js'"), "node --test 'test/*.js'");
});

test('does not add a bail flag twice', () => {
  const already = './node_modules/.bin/vitest run --bail=1';
  assert.equal(addFailFast(already), already);
});

test('an unknown runner is returned unchanged', () => {
  assert.equal(addFailFast('some-custom-runner'), 'some-custom-runner');
});

test('narrowing keeps the bail flag', () => {
  const cmd = narrowCommand({
    command: './node_modules/.bin/vitest run --reporter=basic',
    testFiles: ['/r/tests/a.test.ts'],
    root: '/r',
  });
  assert.match(cmd, /tests\/a\.test\.ts/);
  assert.match(cmd, /--bail=1/);
});
