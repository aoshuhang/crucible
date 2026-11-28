// crucible-ignore-file
// This file's fixtures are deliberately broken test code; crucible scanning its own
// samples would be a false positive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanTestSource, assertionCount } from '../src/detect.js';

test('catches a literal compared to itself', () => {
  const f = scanTestSource("it('x', () => { expect(true).toBe(true); });", 'a.test.ts', { mask: false });
  assert.ok(f.some((x) => x.id === 'always-true'));
});

test('catches a test with no assertion', () => {
  const f = scanTestSource("it('runs', () => { doThing(); });", 'a.test.ts', { mask: false });
  assert.ok(f.some((x) => x.id === 'no-assertion'));
});

test('does not flag a test that asserts', () => {
  const f = scanTestSource("it('works', () => { expect(f()).toBe(1); });", 'a.test.ts', { mask: false });
  assert.equal(f.filter((x) => x.id === 'no-assertion').length, 0);
});

test('catches an empty catch', () => {
  const f = scanTestSource("it('x', () => { try { f(); } catch (e) {} });", 'a.test.ts', { mask: false });
  assert.ok(f.some((x) => x.id === 'empty-catch-in-test'));
});

test('mocking one of several local imports is a collaborator mock, not self-mocking', () => {
  const source = [
    "import { compile } from '../src/compile';",
    "import { warn } from '../src/warn';",
    "vi.mock('../src/warn');",
    "test('compiles', () => { expect(compile('x')).toBe('x'); });",
  ].join('\n');
  const findings = scanTestSource(source, 'compile.spec.ts');
  assert.equal(findings.filter((finding) => finding.id === 'mock-self').length, 0);
});

test('mocking an imported external package is not self-mocking', () => {
  const source = [
    "import axios from 'axios';",
    "vi.mock('axios');",
    "test('client', () => { expect(axios.get).toBeDefined(); });",
  ].join('\n');
  const findings = scanTestSource(source, 'client.spec.ts');
  assert.equal(findings.filter((finding) => finding.id === 'mock-self').length, 0,
    'an external package is a collaborator');
});

test('an expression-bodied JSX test keeps its imported assertion helper', () => {
  const source = [
    "it('mismatch', () =>",
    '  expectMarkupMismatch(',
    '    <div id="foo" />,',
    '    <div suppressHydrationWarning={true} />,',
    '  ));',
  ].join('\n');
  assert.equal(scanTestSource(source, 'reconnect.test.js')
    .filter((finding) => finding.id === 'no-assertion').length, 0);
});

test('a helper assigned in beforeEach counts when a test calls it', () => {
  const source = [
    'describe("component", () => {',
    '  let mount;',
    '  beforeEach(() => {',
    '    mount = async function (props) { render(<div {...props} />); };',
    '  });',
    '  it("renders valid props", async () => { await mount({"aria-label": "x"}); });',
    '});',
  ].join('\n');
  assert.equal(scanTestSource(source, 'component.test.js')
    .filter((finding) => finding.id === 'no-assertion').length, 0);
});

test('a generated testFn wrapper is a smoke/suspect test', async () => {
  const { gradeFinding } = await import('../src/confidence.js');
  const source = [
    'function itRenders(desc, testFn) {',
    '  it(`renders ${desc}`, () => testFn(serverRender));',
    '}',
  ].join('\n');
  const finding = scanTestSource(source, 'utils.js')
    .find((item) => item.id === 'no-assertion');
  assert.ok(finding, 'the generated test is still reported');
  assert.equal(gradeFinding(finding), 'suspect');
});

test('an imported expect* helper counts as an assertion', () => {
  const source = [
    "test('warns', async () => {",
    '  await mountComponent({contentEditable: true});',
    '  await expectConsoleErrorDev([\'warning\']);',
    '});',
  ].join('\n');
  assert.equal(scanTestSource(source, 'component.test.js')
    .filter((finding) => finding.id === 'no-assertion').length, 0);
});

test('expectTypeOf is a compile-time assertion', () => {
  const source = [
    "test('types', () => {",
    '  expectTypeOf(schema.parse(value)).toEqualTypeOf<string>();',
    '});',
  ].join('\n');
  assert.equal(scanTestSource(source, 'types.test.ts')
    .filter((finding) => finding.id === 'no-assertion').length, 0);
});

test('a validation parse smoke test is not a certain fake test', async () => {
  const { gradeFinding } = await import('../src/confidence.js');
  const source = "test('parse valid string', () => { schema.parse(value); });";
  const finding = scanTestSource(source, 'primitive.test.ts')
    .find((item) => item.id === 'no-assertion');
  assert.ok(finding);
  assert.equal(gradeFinding(finding), 'suspect');
});

test('an explicit no-throw smoke test is not a certain fake test', async () => {
  const { gradeFinding } = await import('../src/confidence.js');
  const source = [
    "test('readonly prop on textarea', () => {",
    '  // just to verify that it does not throw when switching types',
    '  patchProp(el, "type", "text", null);',
    '});',
  ].join('\n');
  const finding = scanTestSource(source, 'patchProps.spec.ts')
    .find((item) => item.id === 'no-assertion');
  assert.ok(finding);
  assert.equal(gradeFinding(finding), 'suspect');
});

test('a helper alias created with bind still counts as an assertion', () => {
  const source = [
    'const check = (value) => {',
    '  expect(value).toBe(true);',
    '};',
    'const positive = check.bind(null);',
    "test('wrapped assertion', () => { positive(value); });",
  ].join('\n');
  const findings = scanTestSource(source, 'helper.spec.ts');
  assert.equal(findings.filter((finding) => finding.id === 'no-assertion').length, 0);
});

test('a placeholder inside describe.skip is not double-reported as no-assertion', async () => {
  const { gradeFinding } = await import('../src/confidence.js');
  const source = [
    "describe.skip('Fastify multiple apps', () => {",
    "  it('placeholder');",
    '});',
  ].join('\n');
  const findings = scanTestSource(source, 'e2e/fastify.spec.ts');
  assert.equal(findings.filter((f) => f.id === 'no-assertion').length, 0,
    'the skipped container already explains why the placeholder does not run');
  const skipped = findings.find((f) => f.id === 'skipped');
  assert.equal(gradeFinding(skipped), 'suspect',
    'an intentionally gated integration test is not a certain fake test');
});

test('catches a skipped test', () => {
  const f = scanTestSource("it.skip('later', () => { expect(f()).toBe(1); });", 'a.test.ts', { mask: false });
  assert.ok(f.some((x) => x.id === 'skipped'));
});

test('catches mocking the unit under test', () => {
  const src = `
    import { vi } from 'vitest';
    vi.mock('../src/thing.js');
    import { thing } from '../src/thing.js';
    it('x', () => { expect(thing()).toBe(1); });
  `;
  const f = scanTestSource(src, 'a.test.ts', { mask: false });
  assert.ok(f.some((x) => x.id === 'mock-self'));
});

test('does not double-report one test', () => {
  const src = "it('x', () => { try { f(); } catch (e) {} });";
  const f = scanTestSource(src, 'a.test.ts', { mask: false });
  const lines = f.map((x) => x.line);
  // The empty catch is reported once, and the block is not also "no assertion".
  assert.equal(lines.filter((l) => l === 1).length, 1);
});

test('counts assertions', () => {
  assert.equal(assertionCount('expect(1).toBe(1); expect(2).toBe(2);'), 2);
});

test('a well-written test produces no certain findings', () => {
  const src = `
    import { describe, it, expect } from 'vitest';
    describe('math', () => {
      it('adds', () => { expect(add(1, 2)).toBe(3); });
      it('subtracts', () => { expect(sub(5, 2)).toBe(3); });
    });
  `;
  const f = scanTestSource(src, 'a.test.ts', { mask: false });
  const certain = f.filter((x) => ['always-true', 'no-assertion', 'empty-catch-in-test', 'mock-self'].includes(x.id));
  assert.equal(certain.length, 0);
});

// ---------------------------------------------------------------------------
// Regression tests for the maskStrings bug: `//` used to `break` out of the whole
// scan, so every assertion after the first line comment was invisible. On axios
// that produced 54 false "cannot fail" findings.
// ---------------------------------------------------------------------------

test('finds the assertion after a line comment', () => {
  const src = `
    it('x', () => {
      // this comment used to hide everything below it
      expect(f()).toBe(1);
    });
  `;
  const findings = scanTestSource(src, 'a.test.js', { mask: false });
  assert.equal(findings.filter((f) => f.id === 'no-assertion').length, 0);
});

test('finds the assertion after a block comment', () => {
  const src = `
    it('x', () => {
      /* block
         comment */
      expect(f()).toBe(1);
    });
  `;
  const findings = scanTestSource(src, 'a.test.js', { mask: false });
  assert.equal(findings.filter((f) => f.id === 'no-assertion').length, 0);
});

test('handles several comments before the assertion', () => {
  const src = `
    it('x', () => {
      // one
      // two
      // three
      assert.equal(f(), 1);
    });
  `;
  const findings = scanTestSource(src, 'a.test.js', { mask: false });
  assert.equal(findings.filter((f) => f.id === 'no-assertion').length, 0);
});

test('a test whose callback takes options before the arrow is still parsed', () => {
  // it('name', { retry: 2 }, async () => { expect(...) })
  // Taking the first `{` grabbed `{ retry: 2 }` as the body, so every assertion
  // inside the real callback was invisible.
  const src = `
    it('x', { retry: 2 }, async () => {
      expect(f()).toBe(1);
    });
  `;
  const findings = scanTestSource(src, 'a.test.js', { mask: false });
  assert.equal(findings.filter((f) => f.id === 'no-assertion').length, 0);
});

test('recognises ava t.* assertions', () => {
  const src = `
    test('x', async t => {
      t.true(running <= 4);
      t.deepEqual(a, b);
    });
  `;
  const findings = scanTestSource(src, 'a.test.js', { mask: false });
  assert.equal(findings.filter((f) => f.id === 'no-assertion').length, 0);
});

test('recognises deno assertEquals', () => {
  const src = `
    Deno.test('x', () => {
      assertEquals(typeof axios, 'function');
    });
  `;
  const findings = scanTestSource(src, 'a.test.js', { mask: false });
  assert.equal(findings.filter((f) => f.id === 'no-assertion').length, 0);
});

test('a helper defined in the file counts as possible assertion', () => {
  // axios defines testHeaderValue() at the top and calls it from 54 tests.
  const src = `
    function testHeaderValue(headers, key, value) {
      expect(headers[key]).toBe(value);
    }

    it('x', () => {
      testHeaderValue(req, 'a', 1);
    });
  `;
  const findings = scanTestSource(src, 'a.test.js', { mask: false });
  assert.equal(findings.filter((f) => f.id === 'no-assertion').length, 0);
});

test('recognises a mocha done callback', () => {
  const src = `
    it('x', function(done) {
      route.dispatch(req, {}, done);
    });
  `;
  const findings = scanTestSource(src, 'a.test.js', { mask: false });
  assert.equal(findings.filter((f) => f.id === 'no-assertion').length, 0);
});

test('a try block without a swallowing catch counts as assertion', () => {
  const src = `
    it('x', () => {
      const fixture = build();
      try {
        runCommand('node', ['index.js']);
      } finally {
        cleanup(fixture);
      }
    });
  `;
  const findings = scanTestSource(src, 'a.test.js', { mask: false });
  assert.equal(findings.filter((f) => f.id === 'no-assertion').length, 0);
});

test('a one-line test with no assertion is still caught', () => {
  const src = "it('clamp runs', () => { clamp(5, 0, 10); });";
  const findings = scanTestSource(src, 'a.test.js', { mask: false });
  assert.equal(findings.filter((f) => f.id === 'no-assertion').length, 1);
});

test('a multi-statement test with no assertion is downgraded, not dropped', () => {
  const src = `
    it('should not throw', function () {
      var router = new Router();
      router.route('/foo').all(function () {}).all(function () {});
    });
  `;
  const findings = scanTestSource(src, 'a.test.js', { mask: false });
  const f = findings.find((x) => x.id === 'no-assertion');
  assert.ok(f, 'it stays in the report');
  assert.equal(f.thin, true, 'but marked as thin rather than proven');
});

test('code inside a template literal is not a real test', () => {
  // A test that writes a fixture file containing `it('runs', ...)` must not have its
  // own fixture reported as a test with no assertion.
  const src = `
    const fixture = \`
      import { it } from 'node:test';
      it('runs', () => { doThing(); });
    \`;
    it('real', () => { expect(f()).toBe(1); });
  `;
  const findings = scanTestSource(src, 'a.test.js');
  assert.equal(findings.filter((f) => f.id === 'no-assertion').length, 0);
});

test('a finding on the next test does not suppress this one', () => {
  // The de-duplication range reached one line past the block, so a type-only
  // finding on the following test hid a no-assertion finding on this one.
  const src = [
    "test('clamp runs', () => { clamp(5, 0, 10); });",
    "test('total type', () => assert.equal(typeof total(2), 'number'));",
  ].join('\n');
  const findings = scanTestSource(src, 'a.test.js', { mask: false });
  assert.equal(findings.filter((f) => f.id === 'no-assertion').length, 1,
    'the first test has no assertion and must be reported');
});
