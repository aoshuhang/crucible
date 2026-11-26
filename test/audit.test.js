import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discover } from '../src/discover.js';
import { buildPlan, executePlan, finalizePlan } from '../src/audit.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/project/', import.meta.url));

async function fixtureCopy(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-audit-'));
  await cp(FIXTURE, dir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function targetsFor(dir) {
  const project = await discover(dir);
  return {
    project,
    targets: [...project.covers.entries()]
      .filter(([, tests]) => tests.length > 0)
      .map(([file, testFiles]) => ({ file, testFiles })),
  };
}

function shape(results) {
  return results.map((result) => ({
    file: result.file,
    total: result.total,
    available: result.available,
    killed: result.killed,
    survived: result.survived,
    score: result.score,
    survivors: result.survivors.map((s) => `${s.mutation.line}:${s.mutation.description}`),
  }));
}

test('the mutation selection is deterministic and independent of execution', async (t) => {
  const dir = await fixtureCopy(t);
  const { project, targets } = await targetsFor(dir);

  const first = await buildPlan({
    root: project.root,
    targets,
    command: project.runner.command,
    profile: 'logic',
    maxMutations: 12,
  });
  const second = await buildPlan({
    root: project.root,
    targets,
    command: project.runner.command,
    profile: 'logic',
    maxMutations: 12,
  });

  assert.deepEqual(
    first.map((work) => work.picked.map((m) => `${m.line}:${m.kind}:${m.description}`)),
    second.map((work) => work.picked.map((m) => `${m.line}:${m.kind}:${m.description}`)),
  );
});

test('a parallel sandbox audit reports the same result as the in-place run', async (t) => {
  const sequentialDir = await fixtureCopy(t);
  const parallelDir = await fixtureCopy(t);

  const seq = await targetsFor(sequentialDir);
  const par = await targetsFor(parallelDir);
  const seqSourceFile = seq.targets[0].file;
  const before = await readFile(seqSourceFile, 'utf8');

  const seqPlan = await buildPlan({
    root: seq.project.root,
    targets: seq.targets,
    command: seq.project.runner.command,
  });
  await executePlan({
    root: seq.project.root,
    plan: seqPlan,
    command: seq.project.runner.command,
    jobs: 1,
  });

  const parPlan = await buildPlan({
    root: par.project.root,
    targets: par.targets,
    command: par.project.runner.command,
  });
  await executePlan({
    root: par.project.root,
    plan: parPlan,
    command: par.project.runner.command,
    jobs: 3,
  });

  const sequential = shape(finalizePlan(seqPlan));
  const parallel = shape(finalizePlan(parPlan));

  // Paths differ between the two copies; everything else must match.
  assert.deepEqual(
    parallel.map(({ file, ...rest }) => rest),
    sequential.map(({ file, ...rest }) => rest),
    'sandbox workers must not change the verdicts',
  );

  const after = await readFile(seqSourceFile, 'utf8');
  assert.equal(after, before, 'the user working tree must be byte-identical');
});

test('finalizePlan keeps results in mutation order, not completion order', () => {
  const mutations = [1, 2, 3].map((line) => ({ id: `f:${line}`, line }));
  const plan = [{
    file: '/tmp/f.js',
    all: mutations,
    picked: mutations,
    results: new Map([
      ['f:3', { verdict: 'KILLED', ms: 1 }],
      ['f:1', { verdict: 'SURVIVED', ms: 2 }],
      ['f:2', { verdict: 'KILLED', ms: 3 }],
    ]),
  }];

  const [result] = finalizePlan(plan);
  assert.deepEqual(result.results.map((r) => r.mutation.line), [1, 2, 3]);
  assert.equal(result.killed, 2);
  assert.equal(result.survived, 1);
  assert.equal(result.score, 2 / 3);
});
