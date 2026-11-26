import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discover } from '../src/discover.js';

/**
 * Two bugs found by running against real repositories, both of which made the tool
 * refuse to work on a whole class of projects or lie about the result.
 */

async function project(pkg) {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-ava-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  await writeFile(join(dir, 'src/index.js'), 'export const a = 1;\n');
  return dir;
}

/**
 * A bare binary name like `ava` is only on PATH inside `npm run`, because npm adds
 * node_modules/.bin. Running it directly gives exit 127, which is indistinguishable
 * from a failing suite — so every ava/mocha/tap project was rejected with
 * "suite is red before mutation" and audited nothing.
 */
test('a local test binary is run through npx so it resolves', async (t) => {
  const dir = await project({ name: 'x', scripts: { test: 'ava' } });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const p = await discover(dir);
  assert.ok(p.runner);
  assert.match(p.runner.command, /npx --no-install ava/,
    `a bare binary must be prefixed, got: ${p.runner.command}`);
});

test('mocha gets the same treatment', async (t) => {
  const dir = await project({ name: 'x', scripts: { test: 'mocha' } });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const p = await discover(dir);
  assert.match(p.runner.command, /npx --no-install mocha/);
});

test('does not double-prefix a command that already uses npx', async (t) => {
  const dir = await project({ name: 'x', scripts: { test: 'npx --no-install ava' } });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const p = await discover(dir);
  assert.ok(!p.runner.command.includes('npx --no-install npx'),
    `must not stack prefixes, got: ${p.runner.command}`);
});

test('leaves a node --test command alone', async (t) => {
  const dir = await project({ name: 'x', scripts: { test: 'node --test test/*.js' } });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const p = await discover(dir);
  assert.match(p.runner.command, /^node --test/,
    `node is already global, got: ${p.runner.command}`);
});

test('vitest declared as a dependency is still prefixed correctly', async (t) => {
  const dir = await project({
    name: 'x',
    devDependencies: { vitest: '^1.0.0' },
    scripts: { test: 'vitest run' },
  });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const p = await discover(dir);
  // Either the dependency path or the script path is acceptable, as long as the
  // binary resolves without a download.
  assert.ok(/vitest/.test(p.runner.command));
  assert.ok(!/^vitest/.test(p.runner.command),
    `a bare vitest would fail with 127, got: ${p.runner.command}`);
});
