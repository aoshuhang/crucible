import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mutationsFor, mutationsDetailed, parsesAsScript, applyMutation } from '../src/mutate.js';
import { parseJs } from '../src/js-ast.js';

test('AST mutation never edits a quoted string in a trailing comment', () => {
  const source = 'const x = compute(); // explain "fallback"';
  assert.deepEqual(mutationsFor(source, 'x.js'), []);
});

test('all JS/TS candidates parse as a complete source file', () => {
  const source = `export function choose(n: number): string {
  if (n >= 10 && n !== 20) return n > 15 ? 'large' : 'medium';
  return 'small';
}`;
  const detail = mutationsDetailed(source, 'x.ts');
  assert.equal(detail.parseError, null);
  assert.ok(detail.mutations.length > 5);
  for (const mutation of detail.mutations) {
    assert.ok(parseJs(applyMutation(source, mutation), 'x.ts').ast, mutation.description);
  }
});

test('AST understands nested functions and comments without regex false positives', () => {
  const source = `const label = (n) => {
  // return true; "no mutation in comments"
  return n > 1 ? 'yes' : 'no';
};`;
  const ms = mutationsFor(source, 'x.js');
  assert.ok(ms.some((m) => m.kind === 'comparison'));
  assert.equal(ms.filter((m) => m.kind === 'string').length, 2);
  assert.equal(ms.filter((m) => m.kind === 'return').length, 0);
});

test('TSX gets real syntax validation rather than a FunctionBody approximation', () => {
  const source = 'export function Badge({ n }: { n: number }) { return <span>{n >= 1 ? "many" : "one"}</span>; }';
  const ms = mutationsFor(source, 'Badge.tsx');
  assert.ok(ms.some((m) => m.kind === 'comparison'));
  for (const m of ms) assert.ok(parsesAsScript(applyMutation(source, m), 'Badge.tsx'));
});

test('an invalid source is an explicit parse failure, not a clean scan', () => {
  const detail = mutationsDetailed('export const = broken;', 'x.ts');
  assert.equal(detail.mutations.length, 0);
  assert.match(detail.parseError, /Unexpected/);
});

test('a single-line operator inside a multi-line expression is mutated safely', () => {
  const source = 'export const answer = (\n  40 + 2\n);';
  const mutations = mutationsFor(source, 'x.js');
  assert.ok(mutations.some((m) => m.kind === 'arithmetic'));
  for (const mutation of mutations) {
    assert.ok(parseJs(applyMutation(source, mutation), 'x.js').ast, mutation.description);
  }
});
