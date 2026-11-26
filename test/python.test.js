import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discover } from '../src/discover.js';
import { baseline, auditFile } from '../src/judge.js';
import { mapComparisonsToFunctions, pythonFunctionSpan } from '../src/fix-boundary.js';
import { fixBoundaries } from '../src/fix-boundary.js';

/**
 * Python support. Before this, `scan` worked and `fix` silently did nothing:
 * exportedNames understood `def`, but the function-span finder looked for a `}`
 * and the constant resolver required `const`.
 */

const PY_SOURCE = `MAX_ITEMS = 10

def is_full(count):
    return count >= MAX_ITEMS

def clamp(n, lo, hi):
    if n < lo:
        return lo
    if n > hi:
        return hi
    return n
`;

const PY_TEST = `from src.limits import is_full, clamp

def test_is_full_returns_bool():
    assert isinstance(is_full(5), bool)

def test_clamp_runs():
    clamp(5, 0, 10)
`;

async function pyProject() {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-py-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'tests'), { recursive: true });
  await writeFile(join(dir, 'pytest.ini'), '[pytest]\ntestpaths = tests\n');
  await writeFile(join(dir, 'src/__init__.py'), '');
  await writeFile(join(dir, 'src/limits.py'), PY_SOURCE);
  await writeFile(join(dir, 'tests/test_limits.py'), PY_TEST);
  return dir;
}

test('finds a python function span by indentation', () => {
  const lines = PY_SOURCE.split('\n');
  // `def is_full` is line 3 (index 2); its body is one line.
  assert.deepEqual(pythonFunctionSpan(lines, 2), { start: 3, end: 4 });
  // `def clamp` is line 6 (index 5) and runs to line 11.
  assert.deepEqual(pythonFunctionSpan(lines, 5), { start: 6, end: 11 });
});

test('maps a comparison to the enclosing python function', () => {
  const mapped = mapComparisonsToFunctions(PY_SOURCE, 'limits.py');
  const isFull = mapped.find((m) => m.fn === 'is_full');
  const clamp = mapped.filter((m) => m.fn === 'clamp');

  assert.ok(isFull, 'is_full comparison must map to its function');
  assert.equal(isFull.comparison.op, '>=');
  assert.equal(clamp.length, 2, 'both clamp comparisons must map');
});

test('python line numbers are not shifted by a leading newline', () => {
  // `^\s*` in multiline mode matches the previous newline, which made every line
  // number one too low and attributed comparisons to the wrong function.
  const mapped = mapComparisonsToFunctions(PY_SOURCE, 'limits.py');
  const isFull = mapped.find((m) => m.fn === 'is_full');
  assert.equal(isFull.comparison.line, 4, 'the comparison is on line 4, not 3');
});

test('generates pytest code and raises the score', async (t) => {
  const dir = await pyProject();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const p = await discover(dir);
  assert.equal(p.runner?.name, 'pytest');

  const base = await baseline({ root: p.root, command: p.runner.command });
  assert.equal(base.green, true, `fixture suite must start green: ${base.output}`);

  const src = p.sourceFiles.find((f) => f.endsWith('limits.py'));
  const tests = p.covers.get(src) ?? [];
  assert.ok(tests.length > 0, 'limits.py must map to its test');

  const before = await auditFile({
    root: p.root,
    file: src,
    command: p.runner.command,
    testFiles: tests,
    maxMutations: 12,
  });
  assert.ok(before.score !== null && before.score < 0.5,
    `fake python test should score low, got ${before.score}`);

  const fix = await fixBoundaries({
    root: p.root,
    sourceFile: src,
    testFiles: tests,
    runner: p.runner.command,
    runnerName: 'pytest',
  });
  assert.ok(fix.written, `expected a written test, got: ${fix.reason}`);
  assert.ok(fix.written.endsWith('.py'), 'a python project must get a .py test');

  const body = await readFile(fix.written, 'utf8');
  assert.match(body, /from src\.limits import is_full/, 'must import in python syntax');
  assert.match(body, /def test_/, 'must define a pytest test');
  assert.match(body, /is_full\(9\)/);
  assert.match(body, /is_full\(10\)/);
  assert.match(body, /is_full\(11\)/);

  const afterFix = await baseline({ root: p.root, command: p.runner.command });
  assert.equal(afterFix.green, true, 'suite must stay green after the fix');

  const after = await auditFile({
    root: p.root,
    file: src,
    command: p.runner.command,
    testFiles: tests.length ? [...tests, fix.written] : [fix.written],
    maxMutations: 12,
  });
  assert.ok(after.score > before.score, `score should improve: ${before.score} -> ${after.score}`);
});

test('the python probe is not named like a test file', async (t) => {
  const dir = await pyProject();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const p = await discover(dir);
  const src = p.sourceFiles.find((f) => f.endsWith('limits.py'));
  await fixBoundaries({
    root: p.root,
    sourceFile: src,
    testFiles: p.covers.get(src) ?? [],
    runner: p.runner.command,
    runnerName: 'pytest',
  });

  // A leftover test_*.py probe would be collected by pytest and fail on the
  // missing test functions.
  const base = await baseline({ root: p.root, command: p.runner.command });
  assert.equal(base.green, true, 'no probe file may be left behind for pytest to collect');
});
