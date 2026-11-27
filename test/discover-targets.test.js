import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discover, workspaceDirs, normaliseJsSpec } from '../src/discover.js';

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

test('single-file components are collected for script reading, not counted as unsupported', async (t) => {
  const dir = await project(t);
  await writeFile(join(dir, 'src/App.vue'),
    '<template><div/></template>\n<script>export const n = 1;</script>\n', 'utf8');
  await writeFile(join(dir, 'src/Panel.svelte'),
    '<script>export let p = 2;</script>\n<div/>\n', 'utf8');
  // A format nobody can read is still counted, never silently dropped.
  await writeFile(join(dir, 'src/legacy.rb'), 'puts 1\n', 'utf8');

  const projectInfo = await discover(dir);

  // .vue/.svelte carry a <script> block: check can read it, so the file is a
  // known quantity rather than "unsupported".
  assert.deepEqual(
    projectInfo.sfcFiles.sort().map((f) => f.split('/').pop()),
    ['App.vue', 'Panel.svelte'],
  );
  const byExt = Object.fromEntries(projectInfo.unsupported.map((item) => [item.ext, item.count]));
  assert.equal(byExt['.vue'], undefined, '.vue is handled, not unsupported');
  assert.equal(byExt['.svelte'], undefined, '.svelte is handled, not unsupported');
  assert.equal(byExt['.rb'], 1, 'a genuinely unsupported format is still counted');
});

test('a dotted python module import maps to the nested source file', async (t) => {
  // Regression: `from lib.mod import clamp` produced the key `lib.mod`, which
  // never matched the file key `lib/mod`, so every pytest project audited zero
  // files and `scan` reported an empty `files` list as if the suite were solid.
  const dir = await mkdtemp(join(tmpdir(), 'crucible-discover-py-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'pytest.ini'), '[pytest]\n', 'utf8');
  await mkdir(join(dir, 'lib'), { recursive: true });
  await writeFile(join(dir, 'lib/mod.py'), 'def clamp(v, lo, hi):\n    return v\n', 'utf8');
  await writeFile(join(dir, 't_test.py'),
    'from lib.mod import clamp\n\n\ndef test_clamp():\n    assert clamp(5, 0, 10) == 5\n', 'utf8');

  const projectInfo = await discover(dir);
  const mod = join(dir, 'lib/mod.py');
  assert.deepEqual(projectInfo.covers.get(mod), [join(dir, 't_test.py')],
    'dotted module imports must resolve to lib/mod.py');
});

test('a package-relative python import maps to the sibling source file', async (t) => {
  // Regression: `from .mod import clamp` was resolved as a JS-style relative
  // path (<dir>/.mod), which matched nothing, so packages with __init__.py and
  // intra-package test files audited zero files.
  const dir = await mkdtemp(join(tmpdir(), 'crucible-discover-pyrel-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'pytest.ini'), '[pytest]\n', 'utf8');
  await mkdir(join(dir, 'lib'), { recursive: true });
  await writeFile(join(dir, 'lib/__init__.py'), '', 'utf8');
  await writeFile(join(dir, 'lib/mod.py'), 'def clamp(v, lo, hi):\n    return v\n', 'utf8');
  await writeFile(join(dir, 'lib/t_test.py'),
    'from .mod import clamp\n\n\ndef test_clamp():\n    assert clamp(5, 0, 10) == 5\n', 'utf8');

  const projectInfo = await discover(dir);
  assert.deepEqual(projectInfo.covers.get(join(dir, 'lib/mod.py')), [join(dir, 'lib/t_test.py')],
    '`.mod` inside lib/ must resolve to lib/mod.py');
});

test('a dotted npm package import never maps onto a same-shaped local file', async (t) => {
  // `import whatever from 'lodash.merge'` is an npm package. If dots were
  // treated as path separators for JS tests too, the specifier would become
  // `lodash/merge` and the test would falsely cover a local lodash/merge.js,
  // sending the mutation pass after a file the suite never touches.
  const dir = await mkdtemp(join(tmpdir(), 'crucible-discover-npm-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'probe', type: 'module', scripts: { test: 'node --test' },
  }), 'utf8');
  await mkdir(join(dir, 'lodash'), { recursive: true });
  await writeFile(join(dir, 'lodash/merge.js'), 'export const merge = 1;\n', 'utf8');
  await writeFile(join(dir, 'lodash/nothing.test.js'),
    "import whatever from 'lodash.merge';\nif (whatever) throw new Error('x');\n", 'utf8');

  // The JS-specifier rule keeps dots: `lodash.merge` cannot become `lodash/merge`.
  assert.equal(normaliseJsSpec('lodash.merge'), 'lodash.merge');
  // The test text contains the word `merge` only inside the package specifier,
  // so the basename fallback does not fire either; nothing may map the test
  // onto the file.
  const projectInfo = await discover(dir);
  assert.deepEqual(projectInfo.covers.get(join(dir, 'lodash/merge.js')), [],
    'a dotted npm specifier must not resolve to lodash/merge.js');
});

test('a JS relative import still resolves after the python fix', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-discover-js-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'probe', type: 'module', scripts: { test: 'node --test' },
  }), 'utf8');
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'tests'), { recursive: true });
  await writeFile(join(dir, 'src/a.js'), 'export const a = 1;\n', 'utf8');
  await writeFile(join(dir, 'tests/a.test.js'),
    "import { a } from '../src/a.js';\nif (a !== 1) throw new Error('x');\n", 'utf8');

  const projectInfo = await discover(dir);
  assert.deepEqual(projectInfo.covers.get(join(dir, 'src/a.js')), [join(dir, 'tests/a.test.js')],
    '../src/a.js from tests/ must still resolve to src/a.js');
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
