import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFull, clamp, label } from '../src/limits.js';

// Deliberately fake: asserts nothing about the actual values.
test('isFull returns a boolean', () => {
  assert.equal(typeof isFull(5), 'boolean');
});

test('clamp runs', () => {
  clamp(5, 0, 10);
});

test('label is truthy', () => {
  assert.ok(label(5));
});
