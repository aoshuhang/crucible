import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mutationsFor } from '../src/mutate.js';
import { selectMutations, narrowCommand } from '../src/judge.js';

// ---------------------------------------------------------------------------
// Profiles: tuning constants are not a test-quality signal.
// ---------------------------------------------------------------------------

test('logic profile skips a bare constant declaration', () => {
  const src = 'let maxHealth = 34;\nlet speed = 5.6;';
  const ms = mutationsFor(src, 'x.ts', { profile: 'logic' });
  assert.equal(ms.filter((m) => m.kind === 'number').length, 0,
    'pinning every tuning number is not a quality signal');
});

test('strict profile mutates a bare constant declaration', () => {
  const src = 'let maxHealth = 34;';
  const ms = mutationsFor(src, 'x.ts', { profile: 'strict' });
  assert.ok(ms.some((m) => m.kind === 'number' && m.original === '34'));
});

test('logic profile still mutates a formula in a declaration', () => {
  // `let speed = 5.6 + 0.4 * (size - 1)` changes behaviour, so it is fair game.
  const src = 'let speed = 5.6 + 0.4 * (size - 1);';
  const ms = mutationsFor(src, 'x.ts', { profile: 'logic' });
  assert.ok(ms.some((m) => m.kind === 'arithmetic'), 'formulas must still be mutated');
});

test('logic profile still mutates a comparison in a declaration', () => {
  const src = 'const visible = a > b;';
  const ms = mutationsFor(src, 'x.ts', { profile: 'logic' });
  assert.ok(ms.some((m) => m.kind === 'comparison'));
});

// ---------------------------------------------------------------------------
// New operators.
// ---------------------------------------------------------------------------

test('negates an if condition', () => {
  const src = 'if (ready) { go(); }';
  const ms = mutationsFor(src, 'x.js');
  const cond = ms.find((m) => m.kind === 'condition');
  assert.ok(cond, 'condition negation must be offered');
  assert.match(cond.mutated, /if \(!\(ready\)\)/);
});

test('negates a while condition', () => {
  const src = 'while (queue.length > 0) { pop(); }';
  const ms = mutationsFor(src, 'x.js');
  assert.ok(ms.some((m) => m.kind === 'condition'));
});

test('does not negate an already negated condition', () => {
  const src = 'if (!ready) { go(); }';
  const ms = mutationsFor(src, 'x.js');
  assert.equal(ms.filter((m) => m.kind === 'condition').length, 0,
    'double negation would be equivalent to no change in intent');
});

test('drops a returned value', () => {
  const src = 'function f() { return compute(); }';
  const ms = mutationsFor(src, 'x.js');
  const stmt = ms.find((m) => m.kind === 'statement');
  assert.ok(stmt, 'statement removal must be offered');
  assert.match(stmt.mutated, /return undefined/);
});

test('empties a string literal used as a value', () => {
  const src = "function label(n) { return n > 10 ? 'full' : 'ok'; }";
  const ms = mutationsFor(src, 'x.js');
  const strings = ms.filter((m) => m.kind === 'string');
  assert.equal(strings.length, 2, 'both branches must be mutated');
});

test('does not mutate an object key', () => {
  const src = "const x = { 'a': 1, 'b': 2 };";
  const ms = mutationsFor(src, 'x.js');
  assert.equal(ms.filter((m) => m.kind === 'string').length, 0,
    'object keys are not values');
});

test('does not mutate a module specifier', () => {
  const src = "import x from './some/path.js';";
  const ms = mutationsFor(src, 'x.js');
  assert.equal(ms.filter((m) => m.kind === 'string').length, 0);
});

// ---------------------------------------------------------------------------
// Sampling: even coverage across the file.
// ---------------------------------------------------------------------------

test('selects at most the cap', () => {
  const src = Array.from({ length: 200 }, (_, i) => `if (a${i} > b${i}) { c(); }`).join('\n');
  const ms = mutationsFor(src, 'x.js');
  assert.ok(ms.length > 12);
  assert.equal(selectMutations(ms, 12).length, 12);
});

test('returns everything when under the cap', () => {
  const ms = mutationsFor('if (a > b) { c(); }', 'x.js');
  assert.equal(selectMutations(ms, 12).length, ms.length);
});

test('spreads selections across the whole file, not just the top', () => {
  // 400 lines, one comparison each. A pure priority sort would take the first 12.
  const src = Array.from({ length: 400 }, (_, i) => `if (a${i} > b${i}) { c(); }`).join('\n');
  const ms = mutationsFor(src, 'x.js');
  const picked = selectMutations(ms, 12);
  const lines = picked.map((p) => p.line).sort((a, b) => a - b);

  assert.ok(lines[0] < 60, `first pick should be near the top, got line ${lines[0]}`);
  assert.ok(lines[lines.length - 1] > 340,
    `last pick should be near the bottom, got line ${lines[lines.length - 1]}`);

  // Every pick must be in a distinct region.
  const gap = lines[lines.length - 1] - lines[0];
  assert.ok(gap > 300, `coverage span should be most of the file, got ${gap}`);
});

test('samples every operator kind in proportion, not by priority', () => {
  // 10 numbers, 9 arithmetic, 3 comparisons, 5 statements — the distribution that
  // produced a 67% score on a file whose true score was 44%, because number
  // mutations sorted last and were dropped.
  const src = [
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => `let v${i} = ${i + 10} * k;`),
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => `let w${i} = a${i} + b${i};`),
    ...[0, 1, 2].map((i) => `if (c${i} >= d${i}) { e(); }`),
    ...[0, 1, 2, 3, 4].map((i) => `function s${i}() { return g${i}(); }`),
  ].join('\n');

  const ms = mutationsFor(src, 'x.js');
  const picked = selectMutations(ms, 12);
  const kinds = new Set(picked.map((p) => p.kind));

  // Every kind present in the source must appear in the sample.
  for (const kind of new Set(ms.map((m) => m.kind))) {
    assert.ok(kinds.has(kind), `${kind} was dropped from the sample`);
  }
});

test('a sample of 12 tracks the full run within a few points', () => {
  // The accuracy claim. A sample that flatters the suite by 20 points is worse than
  // no sample at all, so proportional allocation is a correctness property.
  const src = [
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => `let v${i} = ${i + 10};`),
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => `let w${i} = a${i} + b${i};`),
    ...[0, 1, 2].map((i) => `if (c${i} >= d${i}) { e(); }`),
    ...[0, 1, 2, 3, 4].map((i) => `function s${i}() { return g${i}(); }`),
  ].join('\n');

  const ms = mutationsFor(src, 'x.js');
  assert.ok(ms.length > 12);

  const picked = selectMutations(ms, 12);
  const share = (list, kind) => list.filter((m) => m.kind === kind).length / list.length;

  // Each kind's share of the sample should be close to its share of the whole.
  for (const kind of new Set(ms.map((m) => m.kind))) {
    const full = share(ms, kind);
    const sampled = share(picked, kind);
    assert.ok(Math.abs(full - sampled) < 0.15,
      `${kind}: sample share ${sampled.toFixed(2)} vs real ${full.toFixed(2)}`);
  }
});

// ---------------------------------------------------------------------------
// Command narrowing.
// ---------------------------------------------------------------------------

test('narrows a vitest command to the covering tests', () => {
  const cmd = narrowCommand({
    command: 'npx --no-install vitest run --reporter=basic',
    testFiles: ['/r/tests/a.test.ts', '/r/tests/b.test.ts'],
    root: '/r',
  });
  assert.match(cmd, /vitest run/);
  assert.match(cmd, /tests\/a\.test\.ts/);
  assert.match(cmd, /tests\/b\.test\.ts/);
});

test('narrows a node --test command', () => {
  const cmd = narrowCommand({
    command: 'node --test test/*.test.js',
    testFiles: ['/r/test/one.test.js'],
    root: '/r',
  });
  assert.match(cmd, /node --test/);
  assert.match(cmd, /test\/one\.test\.js/);
});

test('keeps the full command when there is no test list', () => {
  const full = 'node --test';
  assert.equal(narrowCommand({ command: full, testFiles: [], root: '/r' }), full);
});

test('keeps the full command when too many files cover the source', () => {
  const full = 'node --test';
  const many = Array.from({ length: 9 }, (_, i) => `/r/t${i}.test.js`);
  assert.equal(narrowCommand({ command: full, testFiles: many, root: '/r' }), full);
});

test('does not narrow a runner it cannot express safely', () => {
  const full = 'cargo test --quiet';
  assert.equal(narrowCommand({ command: full, testFiles: ['/r/a.rs'], root: '/r' }), full,
    'guessing a narrowed cargo command would produce false survivors');
});
