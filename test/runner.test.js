import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discover } from '../src/discover.js';

/**
 * The runner must come from the project's own test script.
 *
 * This is a regression guard for a bug that produced confidently wrong output:
 * unfake guessed `tests/*.test.js` for chalk, which actually keeps its tests in
 * `test/[!_]*.js`. The guessed glob matched nothing, so zero tests ran, the suite
 * was always green, and every mutation was reported as a survivor. The tool said
 * "mutation score 0%" about a project whose tests catch the mutation.
 *
 * A wrong score is worse than no score, so the rule is: use what the project says.
 */
async function makeProject(pkg) {
  const dir = await mkdtemp(join(tmpdir(), 'unfake-runner-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  await writeFile(join(dir, 'src/index.js'), 'export const a = 1;\n');
  return dir;
}

test('uses the project test script instead of guessing a glob', async (t) => {
  const dir = await makeProject({
    name: 'x',
    scripts: { test: "node --test 'test/[!_]*.js'" },
  });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const project = await discover(dir);
  assert.ok(project.runner);
  assert.match(project.runner.command, /test\/\[!_\]\*\.js/,
    'must keep the project\'s own glob, not substitute one');
});

test('strips lint and typecheck steps but keeps the test run', async (t) => {
  const dir = await makeProject({
    name: 'x',
    scripts: { test: "xo && node --test 'test/[!_]*.js' && tsc --noEmit" },
  });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const project = await discover(dir);
  assert.ok(project.runner);
  assert.ok(!project.runner.command.includes('xo'), 'lint must be dropped');
  assert.ok(!project.runner.command.includes('tsc'), 'typecheck must be dropped');
  assert.match(project.runner.command, /node --test/);
});

test('unwraps a coverage runner without losing the command', async (t) => {
  const dir = await makeProject({
    name: 'x',
    scripts: { test: "c8 node --test 'test/*.js'" },
  });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const project = await discover(dir);
  assert.ok(project.runner);
  assert.match(project.runner.command, /node --test/);
  assert.ok(!project.runner.command.startsWith('c8'), 'coverage wrapper must be stripped');
});

test('index.js is treated as source, not skipped as an entry point', async (t) => {
  const dir = await makeProject({ name: 'x', scripts: { test: 'node --test' } });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const project = await discover(dir);
  const names = project.sourceFiles.map((f) => f.split('/').pop());
  assert.ok(names.includes('index.js'),
    `index.js is the library in most packages, got: ${names.join(', ')}`);
});

test('type declaration files are not treated as source', async (t) => {
  const dir = await makeProject({ name: 'x', scripts: { test: 'node --test' } });
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'src/index.d.ts'), 'export declare const a: number;\n');

  const project = await discover(dir);
  const names = project.sourceFiles.map((f) => f.split('/').pop());
  assert.ok(!names.includes('index.d.ts'), 'declaration files have no runtime behaviour');
});
