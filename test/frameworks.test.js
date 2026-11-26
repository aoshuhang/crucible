import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProbe, buildFixTest, buildBoundaryTest } from '../src/fix.js';
import { buildObjectTest } from '../src/fix-object.js';

/**
 * Generated files must be written in the project's own framework. Treating jest as
 * vitest produced `import { it } from 'vitest'` inside jest projects, which cannot
 * resolve and turned the suite red.
 */

const vitestLike = (body) => /from 'vitest'/.test(body);
const nodeTestLike = (body) => /from 'node:test'/.test(body);

test('the probe uses the project framework and never imports vitest for jest', () => {
  const sites = [{ fn: 'isFull', args: '10', call: 'isFull(10)' }];

  const jestProbe = buildProbe({ importPath: './limits.js', sites, runner: 'jest' });
  assert.equal(vitestLike(jestProbe), false);
  assert.match(jestProbe, /\bit\('probe'/);

  const vitestProbe = buildProbe({ importPath: './limits.js', sites, runner: 'vitest' });
  assert.equal(vitestLike(vitestProbe), true);

  const nodeProbe = buildProbe({ importPath: './limits.js', sites, runner: 'node' });
  assert.match(nodeProbe, /from 'node:test'/);
  assert.match(nodeProbe, /\btest\('probe'/);
});

test('a generated value test matches the runner', () => {
  const probed = [{ call: 'isFull(10)', value: true }];

  const jest = buildFixTest({ importPath: './limits.js', probed, sourceName: 'limits', runner: 'jest' });
  assert.equal(vitestLike(jest), false, 'jest must not import vitest');
  assert.equal(nodeTestLike(jest), false, 'jest provides globals, no node:test import');
  assert.match(jest, /expect\(/);

  const vitest = buildFixTest({ importPath: './limits.js', probed, sourceName: 'limits', runner: 'vitest' });
  assert.equal(vitestLike(vitest), true);
  assert.match(vitest, /expect\(/);

  const node = buildFixTest({ importPath: './limits.js', probed, sourceName: 'limits', runner: 'node' });
  assert.equal(vitestLike(node), false);
  assert.match(node, /from 'node:test'/);
  assert.match(node, /assert\.equal/);
});

test('a generated boundary test matches the runner', () => {
  const cases = [{
    fn: 'isFull',
    op: '>=',
    constantName: 'MAX',
    values: { at: 10, below: 9, above: 11 },
    observed: [false, true, true],
  }];

  const jest = buildBoundaryTest({ importPath: './limits.js', sourceName: 'limits', runner: 'jest', cases });
  assert.equal(vitestLike(jest), false);
  assert.match(jest, /expect\(/);
  assert.match(jest, /\(9\)/);

  const vitest = buildBoundaryTest({ importPath: './limits.js', sourceName: 'limits', runner: 'vitest', cases });
  assert.equal(vitestLike(vitest), true);

  const node = buildBoundaryTest({ importPath: './limits.js', sourceName: 'limits', runner: 'node', cases });
  assert.match(node, /from 'node:test'/);
  assert.match(node, /assert\.equal/);
});

test('a generated object-boundary test matches the runner', () => {
  const options = {
    importPath: './limit.js',
    fn: 'canEnter',
    sourceName: 'limit',
    baseText: '{ level: 2 }',
    kind: 'direct',
    field: 'level',
    points: [4, 5, 6],
    nestedValue: String,
    observed: [false, true, true],
    comparison: { left: 'actor.level', op: '>=', right: '5' },
  };

  const jest = buildObjectTest({ ...options, runner: 'jest' });
  assert.equal(vitestLike(jest), false);
  assert.match(jest, /expect\(/);

  const vitest = buildObjectTest({ ...options, runner: 'vitest' });
  assert.equal(vitestLike(vitest), true);

  const node = buildObjectTest({ ...options, runner: 'node' });
  assert.match(node, /from 'node:test'/);
});
