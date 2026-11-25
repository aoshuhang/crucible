import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBoundaryMutation, isLoopBoundary, isThresholdLiteral, rankSurvivors } from '../src/boundary.js';

const lines = [
  'const x = 1;',
  'if (threat.distance <= p.sightRange) {',
  'for (let i = 0; i < 512; i++) {',
  'if (size >= MAX_SIZE) {',
  'if (count >= 10) {',
];

const mut = (kind, original, line) => ({ kind, original, line, mutated: '' });

test('comparison on a real expression is a boundary', () => {
  assert.equal(isBoundaryMutation(mut('comparison', '<=', 2), lines), true);
});

test('loop counters are not boundaries', () => {
  assert.equal(isLoopBoundary(mut('comparison', '<', 3), lines), true);
  assert.equal(isBoundaryMutation(mut('comparison', '<', 3), lines), false);
});

test('a bare assignment is not a boundary', () => {
  assert.equal(isBoundaryMutation(mut('number', '1', 1), lines), false);
});

test('a numeric literal in a loop is not a threshold', () => {
  assert.equal(isThresholdLiteral(mut('number', '512', 3), lines), false);
});

test('a numeric literal inside a comparison is a threshold', () => {
  assert.equal(isThresholdLiteral(mut('number', '10', 5), lines), true);
});

test('ranking puts boundaries first', () => {
  const survivors = [
    { mutation: mut('number', '1', 1) },
    { mutation: mut('comparison', '<=', 2) },
  ];
  const ranked = rankSurvivors(survivors, lines);
  assert.equal(ranked[0].boundary, true);
  assert.equal(ranked[0].mutation.original, '<=');
});

test('boundary carries a concrete description', () => {
  const ranked = rankSurvivors([{ mutation: mut('comparison', '<=', 2) }], lines);
  assert.match(ranked[0].described, /threat\.distance <= p\.sightRange/);
});
