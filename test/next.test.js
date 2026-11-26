import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextStepFor, planFor } from '../src/next.js';

const root = '/p';

test('a boundary finding points at the fix command', () => {
  const next = nextStepFor({ id: 'untested-boundary', kind: 'boundary', file: 'src/a.ts', line: 5 }, { root });
  assert.equal(next.kind, 'run_command');
  assert.match(next.command, /crucible fix/);
});

test('a missing assertion points at the test file and line', () => {
  const next = nextStepFor({ id: 'no-assertion', file: 'test/a.test.js', line: 10 }, { root });
  assert.equal(next.kind, 'edit_test');
  assert.equal(next.file, 'test/a.test.js');
  assert.equal(next.line, 10);
  assert.match(next.instruction, /Add an assertion/);
});

test('a skipped test says re-enable or delete', () => {
  const next = nextStepFor({ id: 'skipped', file: 'test/a.test.js', line: 3 }, { root });
  assert.match(next.instruction, /Re-enable or delete/);
});

test('a self-mocking test says stop mocking the unit', () => {
  const next = nextStepFor({ id: 'mock-self', file: 'test/a.test.js', line: 2 }, { root });
  assert.match(next.instruction, /Stop mocking the module/);
});

test('a type-only assertion says pin the concrete value', () => {
  const next = nextStepFor({ id: 'type-only', file: 'test/a.test.js', line: 9 }, { root });
  assert.equal(next.kind, 'strengthen_assertion');
  assert.match(next.instruction, /concrete value/);
});

test('an unknown finding says review, never claims it is a defect', () => {
  const next = nextStepFor({ id: 'something-new', file: 'x.ts', line: 1 }, { root });
  assert.equal(next.kind, 'review');
  assert.match(next.instruction, /cannot prove/);
});

test('a red suite stops the plan before anything else', () => {
  const plan = planFor({ findings: [], summary: {}, suiteGreen: false, root });
  assert.equal(plan.steps.length, 1);
  assert.match(plan.steps[0].action, /failing suite/);
  assert.ok(plan.doNotClaim.some((c) => /mutation score/.test(c)));
});

test('the plan always ends with a verification step', () => {
  const plan = planFor({
    findings: [{ confidence: 'likely', id: 'untested-boundary' }],
    summary: { worthChecking: 0 },
    suiteGreen: true,
    root,
  });
  const last = plan.steps[plan.steps.length - 1];
  assert.equal(last.action, 'verify');
  assert.match(last.command, /crucible scan/);
});

test('the plan never allows claiming suspect findings are defects', () => {
  const plan = planFor({
    findings: [{ confidence: 'suspect', id: 'type-only' }],
    summary: { worthChecking: 3 },
    suiteGreen: true,
    root,
  });
  assert.ok(plan.doNotClaim.some((c) => /suspect findings are defects/.test(c)));
});

test('steps are numbered in order', () => {
  const plan = planFor({
    findings: [
      { confidence: 'certain', id: 'no-assertion' },
      { confidence: 'likely', id: 'untested-boundary' },
    ],
    summary: { worthChecking: 0 },
    suiteGreen: true,
    root,
  });
  plan.steps.forEach((s, i) => assert.equal(s.order, i + 1));
});
