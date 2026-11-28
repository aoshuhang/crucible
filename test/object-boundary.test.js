import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, rm, mkdtemp, readFile, rm as rmFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { discover } from '../src/discover.js';
import { baseline, auditFile } from '../src/judge.js';
import { fixObjectBoundary } from '../src/fix-object.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/object-args/', import.meta.url));

/**
 * The claim this covers: a comparison on an object field can be fixed by reusing
 * the argument object the project's own tests already build.
 *
 * `canEnter(actor) { return actor.level >= 5; }` cannot be probed with
 * `canEnter(9)`. The tool harvests `const base = { count: 3, level: 2 }` from the
 * test, spreads it with `level: 5`, and pins the result.
 */
test('fixes a boundary on an object field and raises the score', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-obj-'));
  await cp(FIXTURE, dir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));

  await rmFile(join(dir, 'test/limit.canEnter.exact.test.js'), { force: true });

  const project = await discover(dir);
  const [sourceFile, testFiles] = [...project.covers.entries()].find(([, tests]) => tests.length > 0);

  const base = await baseline({ root: project.root, command: project.runner.command });
  assert.equal(base.green, true);

  const before = await auditFile({
    root: project.root,
    file: sourceFile,
    command: project.runner.command,
    maxMutations: 12,
  });
  assert.ok(before.score !== null && before.score < 0.5,
    `fake test should score low, got ${before.score}`);

  const source = await readFile(sourceFile, 'utf8');
  const fixed = await fixObjectBoundary({
    root: project.root,
    sourceFile,
    testFiles,
    fn: 'canEnter',
    comparison: { line: 8, op: '>=', left: 'actor.level', right: '5' },
    source,
    runner: project.runner.name,
  });

  assert.ok(fixed.written, `expected a written test, got: ${fixed.reason}`);

  const afterFix = await baseline({ root: project.root, command: project.runner.command });
  assert.equal(afterFix.green, true, 'suite must still be green');

  const after = await auditFile({
    root: project.root,
    file: sourceFile,
    command: project.runner.command,
    maxMutations: 12,
  });
  assert.ok(after.score > before.score, `score should improve: ${before.score} -> ${after.score}`);
});

test('the generated test spreads the object the tests already build', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-obj2-'));
  await cp(FIXTURE, dir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));

  await rmFile(join(dir, 'test/limit.canEnter.exact.test.js'), { force: true });

  const project = await discover(dir);
  const [sourceFile, testFiles] = [...project.covers.entries()].find(([, tests]) => tests.length > 0);
  const source = await readFile(sourceFile, 'utf8');

  const fixed = await fixObjectBoundary({
    root: project.root,
    sourceFile,
    testFiles,
    fn: 'canEnter',
    comparison: { line: 8, op: '>=', left: 'actor.level', right: '5' },
    source,
    runner: project.runner.name,
  });

  const body = await readFile(fixed.written, 'utf8');
  // The threshold is 5, so the three probe points must be 4, 5 and 6.
  assert.match(body, /level: 4/);
  assert.match(body, /level: 5/);
  assert.match(body, /level: 6/);
  assert.match(body, /\.\.\.base/, 'must reuse the test\'s own base object');
});

test('refuses when all three boundary points return the same value', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-obj3-'));
  await cp(FIXTURE, dir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));

  // A comparison that feeds an intermediate variable: the boundary is invisible at
  // the call site, so a generated test would pin three identical values.
  await rmFile(join(dir, 'test/limit.canEnter.exact.test.js'), { force: true });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(dir, 'src/gate.js'), `
export function gate(p) {
  const near = p.distance <= p.range;
  if (near && p.armed) return 'fire';
  return 'hold';
}
`, 'utf8');
  await writeFile(join(dir, 'test/gate.test.js'), `
import { it } from 'node:test';
import { gate } from '../src/gate.js';
const base = { distance: 1, range: 5, armed: false };
it('runs', () => { gate(base); });
`, 'utf8');

  const project = await discover(dir);
  const sourceFile = project.sourceFiles.find((f) => f.includes('gate.js'));
  const source = await readFile(sourceFile, 'utf8');

  const result = await fixObjectBoundary({
    root: project.root,
    sourceFile,
    testFiles: project.covers.get(sourceFile) ?? [],
    fn: 'gate',
    comparison: { line: 3, op: '<=', left: 'p.distance', right: 'p.range' },
    source,
    runner: project.runner.name,
  });

  assert.equal(result.written, null, 'must not write a test that cannot fail');
  assert.ok(/feeds other logic|could not resolve|no test object/.test(result.reason),
    `expected an honest refusal, got: ${result.reason}`);
});

test('two object boundaries in one module write two distinct files', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-obj4-'));
  await cp(FIXTURE, dir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const project = await discover(dir);
  const [sourceFile, testFiles] = [...project.covers.entries()].find(([, tests]) => tests.length > 0);
  const source = await readFile(sourceFile, 'utf8');

  const first = await fixObjectBoundary({
    root: project.root,
    sourceFile,
    testFiles,
    fn: 'isOverLimit',
    comparison: { line: 4, op: '>', left: 'state.count', right: 'MAX_ITEMS' },
    source,
    runner: project.runner.name,
  });
  const second = await fixObjectBoundary({
    root: project.root,
    sourceFile,
    testFiles,
    fn: 'canEnter',
    comparison: { line: 8, op: '>=', left: 'actor.level', right: '5' },
    source,
    runner: project.runner.name,
  });

  assert.ok(first.written, `expected the first fix, got: ${first.reason}`);
  assert.ok(second.written, `expected the second fix, got: ${second.reason}`);
  assert.notEqual(first.written, second.written, 'each function needs its own file');

  // The first fix must still be on disk: the second write cannot have clobbered it.
  const kept = await readFile(first.written, 'utf8');
  assert.match(kept, /isOverLimit/);
});
