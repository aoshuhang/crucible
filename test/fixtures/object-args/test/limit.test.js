import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isOverLimit, canEnter } from '../src/limit.js';

const base = { count: 3, level: 2 };

// The shape an assistant writes: type checks, no values.
describe('limits', () => {
  it('isOverLimit returns a boolean', () => {
    assert.equal(typeof isOverLimit(base), 'boolean');
  });
  it('canEnter returns a boolean', () => {
    assert.equal(typeof canEnter(base), 'boolean');
  });
});
