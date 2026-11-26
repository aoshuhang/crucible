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
