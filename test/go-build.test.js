import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mutationsFor, mutationsDetailed } from '../src/mutate.js';
import { goBuildExpressionActive } from '../src/go-build.js';

const GO_SOURCE = `//go:build !nomsgpack

package sample

func Add(n int) int {
  return n + 1
}
`;

test('a custom go build tag is inactive by default', () => {
  assert.equal(goBuildExpressionActive('nomsgpack'), false);
  assert.equal(goBuildExpressionActive('!nomsgpack'), true);
  assert.equal(goBuildExpressionActive('nomsgpack || !nomsgpack'), true);
  assert.equal(goBuildExpressionActive('(nomsgpack && linux) || !nomsgpack'), true);
});

test('mutations are skipped in a Go file excluded by the current build', () => {
  const inactive = GO_SOURCE.replace('//go:build !nomsgpack', '//go:build nomsgpack');
  const detail = mutationsDetailed(inactive, 'binding.go');
  assert.equal(detail.mutations.length, 0);
  assert.match(detail.skippedReason, /go:build/);
  assert.ok(mutationsFor(GO_SOURCE, 'binding.go').length > 0,
    'the default-build file must still be mutated');
});
