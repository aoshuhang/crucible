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

test('a directory import resolves to the root index and its reexports', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-discover-index-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'app', type: 'module', scripts: { test: 'node --test' },
  }), 'utf8');
  await mkdir(join(dir, 'lib'), { recursive: true });
  await mkdir(join(dir, 'test'), { recursive: true });
  await writeFile(join(dir, 'index.js'), "export { app } from './lib/application.js';\n", 'utf8');
  await writeFile(join(dir, 'lib/application.js'), 'export const app = () => 1;\n', 'utf8');
  await writeFile(join(dir, 'test/app.test.js'),
    "import { app } from '../';\nif (app() !== 1) throw new Error('x');\n", 'utf8');

  const projectInfo = await discover(dir);
  assert.deepEqual(projectInfo.covers.get(join(dir, 'index.js')), [join(dir, 'test/app.test.js')]);
  assert.deepEqual(projectInfo.covers.get(join(dir, 'lib/application.js')), [join(dir, 'test/app.test.js')],
    'the package entry reexports application.js, so executing it is covered');
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

test('a tsconfig path alias resolves to the real source file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-discover-alias-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'alias-app', type: 'module', scripts: { test: 'node --test' },
  }), 'utf8');
  await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
  }), 'utf8');
  await mkdir(join(dir, 'src/lib'), { recursive: true });
  await mkdir(join(dir, 'tests'), { recursive: true });
  await writeFile(join(dir, 'src/lib/price.ts'), 'export const price = (n: number) => n * 2;\n', 'utf8');
  await writeFile(join(dir, 'tests/price.test.ts'),
    "import { price } from '@/lib/price';\nif (price(2) !== 4) throw new Error('x');\n", 'utf8');

  const projectInfo = await discover(dir);
  assert.deepEqual(projectInfo.covers.get(join(dir, 'src/lib/price.ts')),
    [join(dir, 'tests/price.test.ts')], 'tsconfig aliases are resolved, not guessed');
});

test('python src layout imports resolve to src/<package>/<module>.py', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-discover-pysrc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'pyproject.toml'), '[project]\nname = "mypkg"\n', 'utf8');
  await mkdir(join(dir, 'src/mypkg'), { recursive: true });
  await mkdir(join(dir, 'tests'), { recursive: true });
  await writeFile(join(dir, 'src/mypkg/pricing.py'), 'def price(n):\n    return n * 2\n', 'utf8');
  await writeFile(join(dir, 'tests/test_pricing.py'),
    'from mypkg.pricing import price\n\ndef test_price():\n    assert price(2) == 4\n', 'utf8');

  const projectInfo = await discover(dir);
  assert.deepEqual(projectInfo.covers.get(join(dir, 'src/mypkg/pricing.py')),
    [join(dir, 'tests/test_pricing.py')]);
});

test('an ambiguous python src suffix is not mapped to either package', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-discover-pycollision-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'pytest.ini'), '[pytest]\n', 'utf8');
  await mkdir(join(dir, 'packages/a/src/pkg'), { recursive: true });
  await mkdir(join(dir, 'packages/b/src/pkg'), { recursive: true });
  await mkdir(join(dir, 'tests'), { recursive: true });
  await writeFile(join(dir, 'packages/a/src/pkg/mod.py'), 'def f():\n    return 1\n', 'utf8');
  await writeFile(join(dir, 'packages/b/src/pkg/mod.py'), 'def f():\n    return 2\n', 'utf8');
  await writeFile(join(dir, 'tests/test_mod.py'),
    'from pkg.mod import f\n\ndef test_f():\n    assert f() in (1, 2)\n', 'utf8');

  const projectInfo = await discover(dir);
  assert.deepEqual(projectInfo.covers.get(join(dir, 'packages/a/src/pkg/mod.py')), []);
  assert.deepEqual(projectInfo.covers.get(join(dir, 'packages/b/src/pkg/mod.py')), [],
    'an ambiguous src-layout suffix must not guess a package');
});

test('rust integration tests map to the crate root', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-discover-rust-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'Cargo.toml'), '[package]\nname = "sample"\n', 'utf8');
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'tests'), { recursive: true });
  await writeFile(join(dir, 'src/lib.rs'), 'pub fn twice(n: i32) -> i32 { n * 2 }\n', 'utf8');
  await writeFile(join(dir, 'tests/integration.rs'),
    'use sample::twice;\n#[test]\nfn doubles() { assert_eq!(twice(2), 4); }\n', 'utf8');

  const projectInfo = await discover(dir);
  assert.ok(projectInfo.testFiles.some((file) => file.endsWith('tests/integration.rs')));
  assert.deepEqual(projectInfo.covers.get(join(dir, 'src/lib.rs')),
    [join(dir, 'tests/integration.rs')]);
});

test('a basename mention in comments or strings is a hint, never resolved coverage', async (t) => {
  const dir = await project(t);
  await writeFile(join(dir, 'src/payment.js'), 'export const pay = () => 1;\n', 'utf8');
  await writeFile(join(dir, 'tests/unrelated.test.js'),
    "// payment is mentioned here\nconst fixture = 'payment()';\n", 'utf8');

  const projectInfo = await discover(dir);
  const payment = join(dir, 'src/payment.js');
  assert.deepEqual(projectInfo.covers.get(payment), [],
    'comments and fixture strings are not imported coverage');
  assert.ok(projectInfo.heuristicCovers.get(payment).length === 0,
    'a string/comment does not even elevate the hint');
});

test('test support, examples and tooling are not counted as product source', async (t) => {
  const dir = await project(t);
  await mkdir(join(dir, 'tests/test_apps'), { recursive: true });
  await mkdir(join(dir, 'examples/demo'), { recursive: true });
  await mkdir(join(dir, 'docs'), { recursive: true });
  await mkdir(join(dir, 'docs_src/tutorial'), { recursive: true });
  await mkdir(join(dir, 'integration/_support'), { recursive: true });
  await mkdir(join(dir, 'sample/01-cats-app'), { recursive: true });
  await writeFile(join(dir, 'integration/_support/server.ts'), 'export const port = 0;\n', 'utf8');
  await writeFile(join(dir, 'sample/01-cats-app/app.ts'), 'export const demo = 1;\n', 'utf8');
  await writeFile(join(dir, 'tests/conftest.py'), 'FIXTURE = 1\n', 'utf8');
  await writeFile(join(dir, 'tests/test_apps/support.py'), 'VALUE = 1\n', 'utf8');
  await writeFile(join(dir, 'examples/demo/server.js'), 'export const demo = 1;\n', 'utf8');
  await writeFile(join(dir, 'docs/conf.py'), 'project = "x"\n', 'utf8');
  await writeFile(join(dir, 'docs_src/tutorial/main.py'), 'app = object()\n', 'utf8');
  await writeFile(join(dir, 'playwright.config.js'), 'export default {};\n', 'utf8');

  const projectInfo = await discover(dir);
  const names = projectInfo.sourceFiles.map((file) => file.split('/').pop());
  assert.ok(names.includes('a.js'), 'real src/ source stays');
  assert.ok(!names.includes('conftest.py'));
  assert.ok(!names.includes('support.py'));
  assert.ok(!names.includes('server.js'));
  assert.ok(!names.includes('conf.py'));
  assert.ok(!names.includes('main.py'), 'docs_src tutorials are not product source');
  assert.ok(!names.includes('server.ts'));
  assert.ok(!names.includes('app.ts'), 'sample applications are not product source');
  assert.ok(!names.includes('playwright.config.js'));
  assert.ok(projectInfo.testFiles.some((file) => file.endsWith('tests/a.test.js')),
    'test file discovery is unaffected');
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
