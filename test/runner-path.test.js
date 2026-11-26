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
 * A bare binary name like `ava` is only on PATH inside `npm run`. Running it
 * directly gives exit 127, which is indistinguishable from a failing suite.
 *
 * The first fix used `npx --no-install`, but that falls back to the npx cache when
 * the project has no node_modules — so crucible would run an unrelated ava version
 * against the user's code and report the resulting crash as a failing suite. The
 * command now points at node_modules/.bin directly and marks whether it exists.
 */
test('a local test binary is addressed by its local path', async (t) => {
  const dir = await project({ name: 'x', scripts: { test: 'ava' } });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const p = await discover(dir);
  assert.ok(p.runner);
  assert.match(p.runner.command, /node_modules\/\.bin\/ava/,
    `a bare binary must be addressed locally, got: ${p.runner.command}`);
  assert.equal(p.runner.installed, false, 'and must report that it is not installed');
});

test('mocha gets the same treatment', async (t) => {
  const dir = await project({ name: 'x', scripts: { test: 'mocha' } });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const p = await discover(dir);
  assert.match(p.runner.command, /node_modules\/\.bin\/mocha/);
});

test('never produces a runner command that reaches the npx cache', async (t) => {
  // npx falls back to ~/.npm/_npx when the project has no node_modules, which runs
  // an unrelated version of the binary. The command must address the local path.
  const dir = await project({ name: 'x', scripts: { test: 'npx --no-install ava' } });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const p = await discover(dir);
  assert.ok(!/\bnpx\b/.test(p.runner.command),
    `npx must not appear in the runner command, got: ${p.runner.command}`);
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
