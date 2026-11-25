import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mutationsFor, applyMutation } from '../src/mutate.js';

test('finds comparison mutations', () => {
  const ms = mutationsFor('if (a === b) return 1;');
  const kinds = ms.map((m) => m.kind);
  assert.ok(kinds.includes('comparison'));
  assert.ok(ms.some((m) => m.original === '===' && m.mutated.includes('!==')));
});

test('does not mutate string contents', () => {
  const ms = mutationsFor("const s = 'a === b';");
  assert.equal(ms.filter((m) => m.kind === 'comparison').length, 0);
});

test('does not mutate comments', () => {
  const ms = mutationsFor('// if (a === b) return 1;');
  assert.equal(ms.length, 0);
});

test('does not treat unary minus as arithmetic', () => {
  const ms = mutationsFor('const x = -1;');
  assert.equal(ms.filter((m) => m.kind === 'arithmetic').length, 0);
});

test('treats binary minus as arithmetic', () => {
  const ms = mutationsFor('const x = a - b;');
  assert.ok(ms.some((m) => m.kind === 'arithmetic' && m.original === '-'));
});

test('prefers longest operator match, never overlapping', () => {
  const ms = mutationsFor('if (a === b) {');
  const comparisons = ms.filter((m) => m.kind === 'comparison');
  assert.equal(comparisons.length, 1);
  assert.equal(comparisons[0].original, '===');
});

test('applyMutation changes exactly one line', () => {
  const src = 'line one\nif (a === b) {}\nline three';
  const ms = mutationsFor(src);
  const out = applyMutation(src, ms[0]);
  const before = src.split('\n');
  const after = out.split('\n');
  assert.equal(after.length, before.length);
  const changed = before.filter((l, i) => l !== after[i]);
  assert.equal(changed.length, 1);
});

test('skips import lines', () => {
  const ms = mutationsFor("import { a } from './b.js';");
  assert.equal(ms.length, 0);
});

test('numeric literals are bumped', () => {
  const ms = mutationsFor('if (n > 0) {}');
  const nums = ms.filter((m) => m.kind === 'number');
  assert.equal(nums.length, 1);
  assert.equal(nums[0].original, '0');
  assert.ok(nums[0].mutated.includes('1'));
});

test('boolean return is flipped', () => {
  const ms = mutationsFor('function f() { return true; }');
  const ret = ms.find((m) => m.kind === 'return');
  assert.ok(ret);
  assert.ok(ret.mutated.includes('return false'));
});
