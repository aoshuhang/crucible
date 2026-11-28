import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanTestSource, pythonTestBlocks, maskPython } from '../src/detect.js';
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

test('a nested route handler named test_* is not a pytest test', () => {
  const source = [
    'def test_subdomain():',
    '    app = flask.Flask(__name__)',
    '',
    '    @app.route("/")',
    '    def test_index():',
    '        return "test index"',
    '',
    '    client = app.test_client()',
    '    assert client.get("/").data == b"test index"',
    '',
  ].join('\n');

  const names = pythonTestBlocks(source).map((block) => block.name);
  assert.deepEqual(names, ['test_subdomain'],
    'pytest does not collect a function nested inside another function');
  assert.deepEqual(scanTestSource(source, 'tests/test_basic.py'), []);
});

test('Python masking preserves lines after emoji and triple-quoted strings', () => {
  const source = [
    'class TestThing(TestCase):',
    '    def helper(self):',
    '        """A docstring with "quotes" and',
    '        multiple lines.',
    '        """',
    '        return "🤠"',
    '',
    '    def test_real(self):',
    '        name = "🤠"',
    '        assert name == "🤠"',
    '',
  ].join('\n');

  const masked = maskPython(source);
  assert.equal(masked.length, source.length, 'masking must preserve UTF-16 length');
  assert.equal(masked.split('\n').length, source.split('\n').length);
  assert.deepEqual(scanTestSource(source, 'tests/test_thing.py'), []);
});

test('a test decorated by a custom local assertion helper is not no-assertion', () => {
  const source = [
    'def mutation_test():',
    '    def wrapper(fn):',
    '        def wrapped(self):',
    '            self.assertRaises(ValueError)',
    '        return wrapped',
    '    return wrapper',
    '',
    'class TestThing(TestCase):',
    '    @mutation_test()',
    '    def test_mutated(self):',
    '        mutate()',
    '',
  ].join('\n');
  assert.deepEqual(scanTestSource(source, 'tests/test_thing.py'), []);
});

test('Django-style module-level test helper is not collected as a pytest test', async () => {
  const { gradeFinding } = await import('../src/confidence.js');
  const source = [
    'from django.test import SimpleTestCase',
    '',
    'def test_processor(request):',
    '    return {"processors": "yes"}',
    '',
    'class ThingTests(SimpleTestCase):',
    '    def test_side_effect_only(self):',
    '        call_command("migrate")',
    '',
  ].join('\n');
  const findings = scanTestSource(source, 'tests/test_thing.py');

  assert.equal(findings.some((finding) => finding.snippet.includes('test_processor')), false);
  const classFinding = findings.find((finding) => finding.snippet.includes('test_side_effect_only'));
  assert.ok(classFinding);
  assert.equal(gradeFinding(classFinding), 'suspect',
    'a unittest method may delegate assertions to a base class or setUp');
});

test('a wrapper calling an imported test helper is not a certain fake test', () => {
  const source = [
    'from docs_src.app_testing.tutorial001 import test_read_main',
    '',
    'def test_main():',
    '    test_read_main()',
    '',
  ].join('\n');
  assert.deepEqual(scanTestSource(source, 'tests/test_main.py'), []);
});

test('a Just for coverage call is a smoke test, not a certain fake test', async () => {
  const { gradeFinding } = await import('../src/confidence.js');
  const source = [
    'def test_dummy_callback(mod):',
    '    # Just for coverage',
    '    mod.invoice_notification({})',
    '',
  ].join('\n');
  const finding = scanTestSource(source, 'tests/test_callback.py')
    .find((item) => item.id === 'no-assertion');
  assert.ok(finding);
  assert.equal(gradeFinding(finding), 'suspect');
});

test('SQLAlchemy-style eq_ and is_ helpers are assertions', () => {
  const source = [
    'def test_value():',
    '    eq_(result, expected)',
    '    is_(actual, None)',
    '',
  ].join('\n');
  assert.deepEqual(scanTestSource(source, 'test_types.py'), []);
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
