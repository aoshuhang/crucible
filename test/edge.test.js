import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, chmod, symlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discover } from '../src/discover.js';
import { judgeMutation } from '../src/judge.js';
import { mutationsFor } from '../src/mutate.js';

/**
 * Deliberately awkward inputs: symlink loops, deep nesting, huge files, odd names,
 * unreadable files. Each of these crashed or lied before.
 */

async function pkg(dir, body) {
  await writeFile(join(dir, 'package.json'), JSON.stringify(body));
}

test('survives a symlink loop', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-loop-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src/a.js'), 'export const a = 1;\n');
  await pkg(dir, { name: 'x', scripts: { test: 'node --test' } });

  // A directory that contains itself.
  await symlink(dir, join(dir, 'src/loop'), 'dir').catch(() => {});

  const p = await discover(dir);
  assert.ok(p.sourceFiles.length >= 1, 'the walk must terminate and still find the source');
  assert.ok(p.sourceFiles.length < 100, `a symlink loop must not multiply files, got ${p.sourceFiles.length}`);
});

test('finds files nested deeper than 12 levels', async (t) => {
  // A Java or Kotlin project reaches src/main/java/com/company/product/module/
  // feature without trying. A depth limit of 12 silently found zero files and the
  // report looked like a clean project.
  const dir = await mkdtemp(join(tmpdir(), 'crucible-deep-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  let deep = join(dir, 'src');
  for (let i = 0; i < 30; i += 1) deep = join(deep, `l${i}`);
  await mkdir(deep, { recursive: true });
  await writeFile(join(deep, 'Buried.js'), 'export const deep = 1;\n');
  await pkg(dir, { name: 'x', scripts: { test: 'node --test' } });

  const p = await discover(dir);
  assert.ok(p.sourceFiles.some((f) => f.endsWith('Buried.js')),
    'a file 30 levels down must be found');
});

test('reports that the walk was truncated rather than pretending it saw everything', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-trunc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // Beyond the 64-level limit.
  let deep = join(dir, 'src');
  for (let i = 0; i < 70; i += 1) deep = join(deep, `l${i}`);
  await mkdir(deep, { recursive: true });
  await writeFile(join(deep, 'TooDeep.js'), 'export const x = 1;\n');
  await pkg(dir, { name: 'x', scripts: { test: 'node --test' } });

  const p = await discover(dir);
  assert.equal(p.truncated, true, 'silently missing files is worse than saying so');
});

test('handles odd file names without crashing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-names-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'src'), { recursive: true });
  await pkg(dir, { name: 'x', scripts: { test: 'node --test' } });

  for (const name of ['空格.js', "quote'name.js", '中文.js', 'emoji🔥.js']) {
    await writeFile(join(dir, 'src', name), 'export const v = 1;\n');
  }

  const p = await discover(dir);
  assert.equal(p.sourceFiles.length, 4, 'every odd name must be enumerated');
});

test('an empty file produces no mutations and does not throw', () => {
  const mutations = mutationsFor('', 'empty.js');
  assert.deepEqual(mutations, []);
});

test('a binary file does not crash the mutator', () => {
  // Random bytes are not valid source; the mutator must not assume they are.
  const binary = Array.from({ length: 500 }, (_, i) => String.fromCharCode(i % 256)).join('');
  assert.doesNotThrow(() => mutationsFor(binary, 'binary.js'));
});

test('a large file is parsed in reasonable time', () => {
  const lines = Array.from({ length: 20000 }, (_, i) => `export function f${i}(a) { return a + ${i}; }`);
  const started = Date.now();
  const mutations = mutationsFor(lines.join('\n'), 'big.js');
  const elapsed = Date.now() - started;

  assert.ok(mutations.length > 0);
  assert.ok(elapsed < 5000, `20k lines took ${elapsed}ms`);
});

test('a read-only file is skipped, not crashed on, and left intact', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-ro-'));
  t.after(async () => {
    await chmod(join(dir, 'src/limit.js'), 0o644).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'test'), { recursive: true });
  await writeFile(join(dir, 'src/limit.js'), 'export function isFull(n) { return n >= 10; }\n');
  await writeFile(join(dir, 'test/l.test.js'),
    "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { isFull } from '../src/limit.js';\ntest('x', () => { assert.equal(typeof isFull(5), 'boolean'); });\n");
  await pkg(dir, { name: 'x', type: 'module', scripts: { test: 'node --test test/*.js' } });
  await chmod(join(dir, 'src/limit.js'), 0o444);

  const original = await readFile(join(dir, 'src/limit.js'), 'utf8');
  const mutation = mutationsFor(original, 'limit.js')[0];

  const outcome = await judgeMutation({
    root: dir,
    file: join(dir, 'src/limit.js'),
    command: 'node --test test/*.js',
    mutation,
  });

  assert.equal(outcome.verdict, 'SKIPPED', 'a read-only file cannot be mutated in place');
  assert.match(outcome.reason, /not writable/);

  const after = await readFile(join(dir, 'src/limit.js'), 'utf8');
  assert.equal(after, original, 'the file must be byte-identical');
});

test('a project where nothing is covered is not reported as healthy', async (t) => {
  // Zero findings on a project with no coverage reads as "all good", which is the
  // opposite of the truth. The report has to name the files nothing runs.
  const dir = await mkdtemp(join(tmpdir(), 'crucible-uncov-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'test'), { recursive: true });
  await writeFile(join(dir, 'src/a.js'), 'export const a = 1;\n');
  await writeFile(join(dir, 'src/b.js'), 'export const b = 2;\n');
  await writeFile(join(dir, 'test/orphan.test.js'),
    "import { test } from 'node:test';\ntest('x', () => {});\n");
  await pkg(dir, { name: 'x', type: 'module', scripts: { test: 'node --test test/*.js' } });

  const p = await discover(dir);
  const uncovered = [...p.covers.entries()].filter(([, tests]) => tests.length === 0);

  assert.equal(uncovered.length, 2, 'both sources must be known to be uncovered');
});

// ---------------------------------------------------------------------------
// False positives on real, well-written projects. These matter more than the
// missed detections: a tool that cries wolf on axios or lodash is uninstalled.
// ---------------------------------------------------------------------------

test('an awaited rejects assertion is correct, not a finding', async () => {
  const { scanTestSource } = await import('../src/detect.js');
  const src = "it('x', async () => { await expect(p).rejects.toMatchObject({ code: 'E' }); });";
  const findings = scanTestSource(src, 'a.test.js', { mask: false });
  assert.equal(findings.filter((f) => f.id === 'expect-in-callback-not-awaited').length, 0);
});

test('a rejects assertion without await is a finding', async () => {
  const { scanTestSource } = await import('../src/detect.js');
  const src = "it('x', () => { expect(p).rejects.toBe(1); });";
  const findings = scanTestSource(src, 'a.test.js', { mask: false });
  assert.equal(findings.filter((f) => f.id === 'expect-in-callback-not-awaited').length, 1);
});

test('an arrow that implicitly returns a rejects promise is not a finding', async () => {
  // axios has `const guard = (p) => expect(p).rejects.toMatchObject({...})` and
  // awaits the result at every call site.
  const { scanTestSource } = await import('../src/detect.js');
  const src = [
    'const guard = (promise) =>',
    '  expect(promise).rejects.toMatchObject({',
    "    code: 'ERR_INVALID_URL',",
    '  });',
  ].join('\n');
  const findings = scanTestSource(src, 'a.test.js', { mask: false });
  assert.equal(findings.filter((f) => f.id === 'expect-in-callback-not-awaited').length, 0);
});

test('an empty catch is a smell, never a certain defect', async () => {
  // lodash has 45 of these, all deliberate: feature probes and tolerant resolution.
  const { scanTestSource } = await import('../src/detect.js');
  const { gradeFinding } = await import('../src/confidence.js');
  const findings = scanTestSource(
    "try { require('fs').realpathSync(p); } catch (e) {}",
    'a.test.js',
    { mask: false },
  );
  const empty = findings.find((f) => f.id === 'empty-catch-in-test');
  assert.ok(empty, 'it is still reported');
  assert.equal(gradeFinding(empty), 'suspect', 'but it must not be counted as a fake test');
});
