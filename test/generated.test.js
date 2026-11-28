import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFixTest, buildBoundaryTest } from '../src/fix.js';
import { validateGeneratedTest } from '../src/generated.js';

test('a generated title containing an apostrophe still parses', () => {
  const body = buildFixTest({
    importPath: './api.js',
    sourceName: 'api',
    runner: 'node',
    probed: [{ call: 'quote(name)', value: "It's ok" }],
  });
  const result = validateGeneratedTest(body, 'api.exact.test.js');
  assert.equal(result.valid, true, result.reason);
  assert.ok(body.includes('"It\'s ok"'), 'the assertion value must be valid JS');
});

test('object-valued boundaries get a real deep assertion, not a comment-only test', () => {
  const body = buildBoundaryTest({
    importPath: './limit.js',
    sourceName: 'limit',
    runner: 'node',
    cases: [{
      fn: 'limit',
      op: '>=',
      constantName: 'MAX',
      values: { below: 9, at: 10, above: 11 },
      observed: [{ ok: false }, { ok: true }, { ok: true }],
    }],
  });
  const result = validateGeneratedTest(body, 'limit.exact.test.js');
  assert.equal(result.valid, true, result.reason);
  assert.match(body, /assert\.deepEqual/);
  assert.doesNotMatch(body, /unrepresentable value/);
});

test('a generated file with no assertion fails the contract', () => {
  const result = validateGeneratedTest(
    "import { describe, it } from 'node:test';\ndescribe('x', () => { it('y', () => {}); });\n",
    'empty.test.js',
  );
  assert.equal(result.valid, false);
  assert.match(result.reason, /no assertion/);
});
