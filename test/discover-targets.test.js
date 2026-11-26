import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discover, workspaceDirs } from '../src/discover.js';

async function project(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-discover-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'probe',
    type: 'module',
    scripts: { test: 'node --test tests/*.test.js' },
  }), 'utf8');
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'tests'), { recursive: true });
  await writeFile(join(dir, 'src/a.js'), 'export const a = 1;\n', 'utf8');
  await writeFile(join(dir, 'tests/a.test.js'),
    "import assert from 'node:assert/strict';\nimport { a } from '../src/a.js';\nassert.equal(a, 1);\n", 'utf8');

  return dir;
}

test('a source file target audits only that file, in its project', async (t) => {
  const dir = await project(t);
  const file = join(dir, 'src/a.js');

  const projectInfo = await discover(file);

  assert.equal(projectInfo.root, dir);
  assert.equal(projectInfo.targetedFile, 'src/a.js');
  assert.deepEqual(projectInfo.sourceFiles, [file]);
  assert.deepEqual(projectInfo.covers.get(file), [join(dir, 'tests/a.test.js')]);
  assert.ok(projectInfo.runner, 'the runner is found from the owning project');
  assert.equal(projectInfo.runner.name, 'package script');
});

test('a test file target checks only that file', async (t) => {
  const dir = await project(t);
  const file = join(dir, 'tests/a.test.js');

  const projectInfo = await discover(file);

  assert.equal(projectInfo.targetedFile, 'tests/a.test.js');
  assert.deepEqual(projectInfo.testFiles, [file]);
  assert.deepEqual(projectInfo.sourceFiles, []);
});

test('files in formats crucible cannot parse are counted, not silently dropped', async (t) => {
  const dir = await project(t);
  await writeFile(join(dir, 'src/App.vue'), '<template><div/></template>\n', 'utf8');
  await writeFile(join(dir, 'src/Panel.svelte'), '<div/>\n', 'utf8');

  const projectInfo = await discover(dir);
  const byExt = Object.fromEntries(projectInfo.unsupported.map((item) => [item.ext, item.count]));

  assert.equal(byExt['.vue'], 1);
  assert.equal(byExt['.svelte'], 1);
});

test('workspace packages are detected from package.json globs', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-ws-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }), 'utf8');
  await mkdir(join(dir, 'packages/a'), { recursive: true });
  await mkdir(join(dir, 'packages/b'), { recursive: true });
  await mkdir(join(dir, 'packages/not-a-package'), { recursive: true });
  await writeFile(join(dir, 'packages/a/package.json'), '{"name":"a"}', 'utf8');
  await writeFile(join(dir, 'packages/b/pyproject.toml'), '[project]\nname="b"\n', 'utf8');

  assert.deepEqual(await workspaceDirs(dir), [
    join(dir, 'packages/a'),
    join(dir, 'packages/b'),
  ]);
});

test('workspace packages are detected from pnpm-workspace.yaml and negations are skipped', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-ws-pnpm-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'pnpm-workspace.yaml'),
    "packages:\n  - 'apps/*'\n  - '!apps/legacy'\n", 'utf8');
  await mkdir(join(dir, 'apps/web'), { recursive: true });
  await mkdir(join(dir, 'apps/legacy'), { recursive: true });
  await writeFile(join(dir, 'apps/web/package.json'), '{"name":"web"}', 'utf8');
  await writeFile(join(dir, 'apps/legacy/package.json'), '{"name":"legacy"}', 'utf8');

  assert.deepEqual(await workspaceDirs(dir), [join(dir, 'apps/web')]);
});
