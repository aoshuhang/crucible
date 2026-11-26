import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mutationsFor } from '../src/mutate.js';
import { scanTestSource } from '../src/detect.js';

test('a ternary is mutated by swapping its branches', () => {
  const mutations = mutationsFor('const pick = flag ? a : b;');
  const swap = mutations.find((m) => m.description === 'swap the ternary branches');

  assert.ok(swap, 'expected a ternary mutation');
  assert.equal(swap.mutated, 'const pick = flag ? b : a;');
});

test('optional chaining and nullish coalescing are not ternaries', () => {
  for (const line of ['const x = a?.b;', 'const x = a ?? b;']) {
    const swaps = mutationsFor(line).filter((m) => m.description === 'swap the ternary branches');
    assert.deepEqual(swaps, [], line);
  }
});

test('a ternary inside an array does not swallow the following elements', () => {
  // The else-branch ends at the comma, not at the end of the statement.
  const swap = mutationsFor('const list = [flag ? a : b, c];')
    .find((m) => m.description === 'swap the ternary branches');

  assert.ok(swap);
  assert.equal(swap.mutated, 'const list = [flag ? b : a, c];');
});

test('an if condition is also forced true, not only negated', () => {
  const mutations = mutationsFor('if (x > 1) {');
  const forced = mutations.find((m) => m.description === 'force the condition true');

  assert.ok(forced, 'expected a force-true mutation');
  assert.equal(forced.mutated, 'if (true) {');
  assert.match(forced.mutated, /^if \(true\)/);
});

test('jest.mock on the imported module is reported as self-mocking', () => {
  const source = [
    "import { isFull } from '../src/limits.js';",
    "jest.mock('../src/limits.js');",
    '',
    "test('x', () => { expect(isFull(10)).toBe(true); });",
    '',
  ].join('\n');

  const findings = scanTestSource(source, 'test/x.test.js');
  assert.ok(findings.some((f) => f.id === 'mock-self'));
});

test('mocking a collaborator is not self-mocking', () => {
  const source = [
    "import { isFull } from '../src/limits.js';",
    "jest.mock('../src/db.js');",
    '',
    "test('x', () => { expect(isFull(10)).toBe(true); });",
    '',
  ].join('\n');

  const findings = scanTestSource(source, 'test/x.test.js');
  assert.ok(!findings.some((f) => f.id === 'mock-self'));
});
