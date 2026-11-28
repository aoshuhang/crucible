import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pythonMutations, pythonMutationsDetailed } from '../src/python-mutate.js';
import { buildPythonBoundaryTest } from '../src/python.js';
import { pythonCommand } from '../src/python-runtime.js';

const HELPER_PATH = fileURLToPath(new URL('../src/python_ast.py', import.meta.url));

function parsesInPython(source) {
  const result = spawnSync(pythonCommand(), ['-I', '-c', 'import ast,sys; ast.parse(sys.stdin.read())'], {
    input: source,
    encoding: 'utf8',
    timeout: 10_000,
  });
  return result.status === 0;
}

function applyPythonMutation(source, mutation) {
  const lines = source.split('\n');
  lines[mutation.line - 1] = mutation.mutated;
  return lines.join('\n');
}

test('python mutations carry the shared shape and unique ids', () => {
  const source = [
    'MAX_ITEMS = 10',
    '',
    'def is_full(count):',
    '    return count >= MAX_ITEMS',
    '',
  ].join('\n');

  const mutations = pythonMutations(source, 'limits.py');
  assert.ok(mutations.length > 0, 'a comparison should produce mutations');

  const ids = new Set(mutations.map((mutation) => mutation.id));
  assert.equal(ids.size, mutations.length, 'mutation ids must be unique');

  const comparison = mutations.find((mutation) => mutation.kind === 'comparison');
  assert.ok(comparison, 'the comparison operator must be mutable');
  assert.equal(comparison.language, 'python');
  assert.equal(comparison.original, '>=');
  assert.equal(comparison.mutated, '    return count > MAX_ITEMS');
  assert.ok(Number.isInteger(comparison.line));
  assert.ok(Number.isInteger(comparison.column));

  for (const mutation of mutations) {
    assert.equal(
      applyPythonMutation(source, mutation).split('\n')[mutation.line - 1],
      mutation.mutated,
      'the shared whole-line mutation shape must apply cleanly',
    );
    assert.ok(
      parsesInPython(applyPythonMutation(source, mutation)),
      `candidate ${mutation.id} must parse with ast.parse`,
    );
  }
});

test('comparison, boolean, condition, return, number and string operators are covered', () => {
  const source = [
    'def check(a, b, flag, label):',
    '    if a >= b:',
    '        return True',
    '    while flag and not a:',
    '        return False',
    "    if label == 'ok' or len(label) > 1:",
    "        return 'done'",
    '    return 5',
    '',
  ].join('\n');

  const mutations = pythonMutations(source, 'ops.py');
  const byDescription = new Map(mutations.map((mutation) => [mutation.description, mutation]));

  assert.equal(mutations.find((mutation) => mutation.description === 'negate the condition' && mutation.line === 2)?.mutated, '    if not (a >= b):');
  assert.equal(byDescription.get('flip >= to >')?.mutated, '    if a > b:');
  assert.equal(byDescription.get('flip and to or')?.mutated, '    while flag or not a:');
  assert.equal(byDescription.get('flip True to False')?.mutated, '        return False');
  assert.equal(byDescription.get('flip False to True')?.mutated, '        return True');
  assert.equal(byDescription.get('flip == to !=')?.mutated, "    if label != 'ok' or len(label) > 1:");
  assert.equal(byDescription.get('flip > to >=')?.mutated, "    if label == 'ok' or len(label) >= 1:");
  assert.equal(byDescription.get('drop the returned value')?.mutated, '    return None');
  assert.equal(byDescription.get('bump 5 to 6')?.mutated, '    return 6');
  assert.equal(byDescription.get('empty the string "ok"')?.mutated, "    if label == '' or len(label) > 1:");

  const comparisonPositions = new Set(
    mutations.filter((mutation) => mutation.kind === 'comparison')
      .map((mutation) => `${mutation.line}:${mutation.column}`),
  );
  assert.equal(
    comparisonPositions.size,
    mutations.filter((mutation) => mutation.kind === 'comparison').length,
    'no comparison may be emitted twice from the same operator token',
  );
});

test('strict profile mutates a bare python constant; logic does not', () => {
  const source = 'MAX_RETRIES = 3\n';
  assert.equal(pythonMutations(source, 'settings.py', { profile: 'logic' })
    .filter((mutation) => mutation.kind === 'number').length, 0);
  assert.ok(pythonMutations(source, 'settings.py', { profile: 'strict' })
    .some((mutation) => mutation.kind === 'number'));
});

test('comments, docstrings, imports and literal-only declarations are not mutated', () => {
  const source = [
    '# if a >= b:',
    'import os',
    'from math import sqrt',
    'MAX_ITEMS = 10',
    'RATE = 0.25',
    '',
    'def described():',
    '    """Return 999 and label it ">= done"."""',
    "    return 'ready'",
    '',
  ].join('\n');

  const mutations = pythonMutations(source, 'noise.py');
  const lines = mutations.map((mutation) => mutation.line);
  assert.deepEqual(new Set(lines), new Set([9]), 'only live logic lines may change');
  assert.equal(
    mutations.some((mutation) => /import|MAX_ITEMS|RATE|"""|#/.test(mutation.mutated.split('\n')[0])),
    false,
    'imports, literal declarations, docstrings and comments must stay untouched',
  );
  assert.equal(mutations.some((mutation) => mutation.original === '999'), false);
  assert.equal(mutations.some((mutation) => mutation.original === '>='), false);
});

test('unparenthesized if and while conditions can be negated, while unreliable spans are skipped', () => {
  const source = [
    'def go(flag, other):',
    '    if flag:',
    '        return flag',
    '    while other:',
    '        other = other - 1',
    '    if (flag and',
    '        other):',
    '        return True',
    '',
  ].join('\n');

  const mutations = pythonMutations(source, 'spans.py');
  assert.equal(
    mutations.some((mutation) => mutation.description === 'negate the condition'
      && mutation.mutated === '    if not (flag):'),
    true,
  );
  assert.equal(
    mutations.some((mutation) => mutation.description === 'negate the condition'
      && mutation.mutated === '    while not (other):'),
    true,
  );
  assert.equal(
    mutations.filter((mutation) => mutation.description === 'negate the condition').length,
    2,
    'multi-line condition spans must be skipped instead of half-rewritten',
  );
  assert.equal(
    mutations.filter((mutation) => mutation.description === 'drop the returned value').length,
    1,
    'multi-line return expressions must be skipped instead of half-rewritten',
  );
});

test('parse failures and unavailable helpers are reported honestly', () => {
  const bad = pythonMutationsDetailed('def broken(:\n', 'broken.py');
  assert.deepEqual(bad.mutations, []);
  assert.equal(bad.available, true);
  assert.match(bad.parseError, /syntax error/i);

  const syntaxHelper = spawnSync(pythonCommand(), ['-I', '-c', 'import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())', HELPER_PATH], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(syntaxHelper.status, 0, `helper itself must parse: ${syntaxHelper.stderr}`);
});

test('helper emits no duplicate mutation for one operator occurrence', () => {
  const source = 'def f(a, b):\n    return a >= b and b >= a\n';
  const mutations = pythonMutations(source, 'dupes.py');
  const ge = mutations.filter((mutation) => mutation.original === '>=');
  assert.equal(ge.length, 2, 'two distinct >= operators should be found');
  assert.notEqual(ge[0].column, ge[1].column, 'each operator gets its own coordinates');
});

test('python boundary generator skips unusable cases and keeps names unique', () => {
  const body = buildPythonBoundaryTest({
    importPath: 'src.limits',
    sourceName: 'limits',
    cases: [
      {
        fn: 'is_full',
        constantName: 'MAX_ITEMS',
        values: { below: 9, at: 10, above: 11 },
        observed: [false, true, true],
        comparison: { line: 4, column: 11 },
      },
      {
        fn: 'is_full',
        constantName: 'MAX_ITEMS',
        values: { below: 9, at: 10, above: 11 },
        observed: [false, true, true],
      },
      {
        fn: 'same_value',
        constantName: 'LIMIT',
        values: { below: 0, at: 1, above: 2 },
        observed: ['same', 'same', 'same'],
      },
      {
        fn: 'not_finite',
        constantName: 'LIMIT',
        values: { below: 0, at: 1, above: 2 },
        observed: [Number.NaN, 1, 2],
      },
    ],
  });

  const defs = [...body.matchAll(/^def (test_[\w_]+)\(\):$/gm)].map((match) => match[1]);
  assert.equal(defs.length, 2, 'unusable cases must not become defs');
  assert.equal(new Set(defs).size, defs.length, 'def names must stay unique');
  assert.match(body, /def test_is_full_at_max_items_boundary\(\):/);
  assert.match(body, /def test_is_full_at_max_items_boundary_case_2\(\):/);
  assert.doesNotMatch(body, /def test_same_value|def test_not_finite/, 'weak cases must be skipped');
  assert.doesNotMatch(body, /NaN|Infinity/, 'non-finite values must never be asserted');

  assert.equal(parsesInPython(body), true, `generated boundary test must parse:\n${body}`);
});

test('python boundary generator can honestly return imports only', () => {
  const body = buildPythonBoundaryTest({
    importPath: 'src.limits',
    sourceName: 'limits',
    cases: [{
      fn: 'quiet',
      constantName: 'LIMIT',
      values: { below: 0, at: 1, above: 2 },
      observed: [undefined, undefined, undefined],
    }],
  });

  assert.match(body, /import os\nimport sys/);
  assert.doesNotMatch(body, /^def test_/m, 'no usable case means no fake empty test');
  assert.equal(parsesInPython(body), true, `imports-only output must still parse:\n${body}`);
});
