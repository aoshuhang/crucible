import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harvestObjectLiterals, fieldNames, candidateFields, chooseCarrier,
  isDirectlyObservable } from '../src/fix-object.js';

test('harvests object literals with their type annotation', () => {
  const src = `
    const base: Perception = {
      healthFrac: 1,
      sightRange: 15,
    };
  `;
  const lits = harvestObjectLiterals(src);
  assert.equal(lits.length, 1);
  assert.equal(lits[0].name, 'base');
  assert.equal(lits[0].type, 'Perception');
});

test('reads top-level field names, ignoring nested objects', () => {
  const names = fieldNames('{ count: 3, level: 2, nested: { a: 1, b: 2 } }');
  assert.deepEqual(names, ['count', 'level', 'nested']);
});

test('offers the last path segment first, then the first', () => {
  // `state.count` where state is the parameter name: the field is `count`.
  assert.deepEqual(candidateFields('state.count'), ['count', 'state']);
  // `threat.distance` where p is the parameter: the field is `threat`.
  assert.deepEqual(candidateFields('threat.distance'), ['distance', 'threat']);
  assert.deepEqual(candidateFields('count'), ['count']);
});

test('picks a flat carrier when the object has the field', () => {
  const literals = [{ name: 'base', type: null, text: '{ count: 3, level: 2 }' }];
  const carrier = chooseCarrier({
    comparison: { left: 'state.count', op: '>', right: 'MAX' },
    literals,
  });
  assert.equal(carrier.base, 'base');
  assert.equal(carrier.kind, 'direct');
  assert.equal(carrier.field, 'count');
});

test('picks a nested carrier when the field names a sub-object', () => {
  const literals = [{ name: 'base', type: null, text: '{ healthFrac: 1, nearestThreat: null }' }];
  const carrier = chooseCarrier({
    comparison: { left: 'threat.distance', op: '<=', right: 'sight' },
    literals,
  });
  assert.equal(carrier.kind, 'nested');
  assert.equal(carrier.field, 'nearestThreat');
});

test('returns null when nothing carries the field', () => {
  const literals = [{ name: 'base', type: null, text: '{ a: 1 }' }];
  const carrier = chooseCarrier({
    comparison: { left: 'widget.size', op: '>', right: 'MAX' },
    literals,
  });
  assert.equal(carrier, null);
});

test('a comparison that is returned directly is observable', () => {
  const source = `
    export function isOverLimit(state) {
      return state.count > MAX_ITEMS;
    }
  `;
  assert.equal(isDirectlyObservable({
    comparison: { left: 'state.count', op: '>', right: 'MAX_ITEMS' },
    source,
    fnName: 'isOverLimit',
  }), true);
});

test('a comparison feeding other branches is not observable', () => {
  // This is the shape that made the first version of the tool write a test pinning
  // three identical values. Probing 14/15/16 all returned 'wander' because the real
  // difference only appears when other conditions also hold.
  const source = `
    export function decideState(p) {
      const threatVisible = !!p.threat && p.threat.distance <= p.sightRange;
      if (threatVisible && p.healthFrac < 0.3) return 'flee';
      return 'wander';
    }
  `;
  assert.equal(isDirectlyObservable({
    comparison: { left: 'p.threat.distance', op: '<=', right: 'p.sightRange' },
    source,
    fnName: 'decideState',
  }), false);
});
