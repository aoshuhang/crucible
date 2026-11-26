import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanTestSource, pythonTestBlocks } from '../src/detect.js';
import { hasValuePinningAssertions } from '../src/confidence.js';

/**
 * `crucible check` was effectively silent on pytest projects: every block rule
 * looked for `it(...)`. These are the Python shapes it must see.
 */

test('a pytest function with no assertion is reported', () => {
  const source = [
    'def test_clamp_runs():',
    '    clamp(5, 0, 10)',
    '',
  ].join('\n');

  const findings = scanTestSource(source, 'test_limits.py');
  assert.deepEqual(findings.map((f) => [f.id, f.line]), [['no-assertion', 1]]);
});

test('an assertion, pytest.raises or a raise counts as a test', () => {
  const source = [
    'def test_value():',
    '    assert is_full(10) is True',
    '',
    'def test_raises():',
    '    with pytest.raises(ValueError):',
    '        clamp(-1, 0, 10)',
    '',
    'def test_raise_directly():',
    '    raise AssertionError("not implemented yet")',
    '',
  ].join('\n');

  assert.deepEqual(scanTestSource(source, 'test_limits.py'), []);
});

test('a skipped pytest function is reported as skipped but not as empty', () => {
  const source = [
    '@pytest.mark.skip(reason="wip")',
    'def test_skipped():',
    '    is_full(10)',
    '',
  ].join('\n');

  const ids = scanTestSource(source, 'test_limits.py').map((f) => f.id);
  assert.ok(ids.includes('skipped'), 'the decorator is a skipped test');
  assert.ok(!ids.includes('no-assertion'), 'skip explains why there is no assertion');
});

test('except ...: pass is reported as swallowing the error', () => {
  const source = [
    'def test_swallow():',
    '    try:',
    '        clamp(5, 0, 10)',
    '    except ValueError:',
    '        pass',
    '',
  ].join('\n');

  const ids = scanTestSource(source, 'test_limits.py').map((f) => f.id);
  assert.ok(ids.includes('empty-catch-in-test'));
});

test('pythonTestBlocks finds nested and top-level test functions', () => {
  const source = [
    'class TestLimits:',
    '    def test_nested(self):',
    '        assert is_full(10)',
    '',
    '    def helper(self):',
    '        return 1',
    '',
    'def test_top():',
    '    assert is_full(9) is False',
    '',
    'def unrelated():',
    '    pass',
    '',
  ].join('\n');

  const names = pythonTestBlocks(source).map((block) => block.name);
  assert.deepEqual(names, ['test_nested', 'test_top']);
});

test('value pinning is recognised in node:test, ava and pytest dialects', () => {
  assert.equal(hasValuePinningAssertions("assert.equal(isFull(10), true);"), true);
  assert.equal(hasValuePinningAssertions("assert.deepStrictEqual(state, { count: 3 });"), true);
  assert.equal(hasValuePinningAssertions("t.is(isFull(10), true);"), true);
  assert.equal(hasValuePinningAssertions('assert is_full(10) is True'), true);
  assert.equal(hasValuePinningAssertions("assert x == 3\n"), true);
  assert.equal(hasValuePinningAssertions("assert.equal(typeof x, 'boolean');"), true);

  assert.equal(hasValuePinningAssertions('assert(x > 1);'), false);
  assert.equal(hasValuePinningAssertions('expect(x).toBeDefined();'), false);
  assert.equal(hasValuePinningAssertions('t.true(x);'), false);
});

test('a one-line except ...: pass is reported once, not twice', () => {
  const source = [
    'def test_swallow():',
    '    try:',
    '        clamp(5, 0, 10)',
    '    except ValueError: pass',
    '',
  ].join('\n');

  const findings = scanTestSource(source, 'test_limits.py').filter((f) => f.id === 'empty-catch-in-test');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 4);
});
