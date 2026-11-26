/**
 * Parallel audit execution.
 *
 * `judgeMutation` rewrites a file in place, which is why audits used to be strictly
 * sequential. The safe way to parallelise is to give each worker its own copy of the
 * project: the runner resolves against the copy, mutations are applied there, and the
 * user's working tree is never touched at all.
 *
 * A sandbox is only used when it can prove itself: every copy must run the suite green
 * once before any mutation is trusted. A copy that cannot resolve dependencies would
 * make every mutant look killed — a confident but false clean bill of health, the
 * failure mode this tool is least allowed to have.
 */

import { readFile, rm, cp, mkdtemp, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { mutationsFor } from './mutate.js';
import { selectMutations, judgeMutation, narrowCommand, run } from './judge.js';
import { registerSandbox, unregisterSandbox } from './judge.js';
import { relPosix, baseName } from './paths.js';

/** Never copied into a sandbox: dependencies are linked, history is irrelevant. */
const SANDBOX_SKIP = new Set(['node_modules', '.git', '.DS_Store']);

/**
 * Choose the mutations for every file up front.
 *
 * Doing this before scheduling keeps the selection deterministic regardless of which
 * worker happens to run a task, so two runs of the same project audit the same mutants.
 */
export async function buildPlan({ root, targets, command, profile = 'logic', maxMutations = 12 }) {
  const plan = [];
  for (const target of targets) {
    const source = await readFile(target.file, 'utf8');
    const all = mutationsFor(source, target.file, { profile });
    const picked = selectMutations(all, maxMutations);
    plan.push({
      file: target.file,
      testFiles: target.testFiles,
      source,
      all,
      picked,
      effective: narrowCommand({ command, testFiles: target.testFiles, root }),
      results: new Map(),
    });
  }
  return plan;
}

/**
 * Run the planned mutations and return the plan with a result map per file.
 *
 * jobs === 1 keeps the original in-place behaviour: no copy, no extra baseline, and
 * exactly one file is mutated at a time.
 */
export async function executePlan({ root, plan, command, jobs = 1, onProgress, timeoutMs = 120_000 }) {
  const tasks = [];
  plan.forEach((work, index) => {
    for (const mutation of work.picked) tasks.push({ index, mutation });
  });
  if (tasks.length === 0) return plan;

  let sandboxes = [];
  if (jobs > 1 && tasks.length > 1) {
    sandboxes = await trySandboxes({ root, count: Math.min(jobs, tasks.length), command });
  }

  if (sandboxes.length === 0) {
    for (const task of tasks) await runTask(task, { root, plan, onProgress, timeoutMs });
    return plan;
  }

  let cursor = 0;
  const worker = async (sandbox) => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= tasks.length) return;
      await runTask(tasks[i], { root, plan, onProgress, timeoutMs, sandbox });
    }
  };

  try {
    await Promise.all(sandboxes.map(worker));
  } finally {
    for (const sandbox of sandboxes) {
      await rm(sandbox.base, { recursive: true, force: true }).catch(() => {});
      unregisterSandbox(sandbox.base);
    }
  }
  return plan;
}

async function runTask({ index, mutation }, { root, plan, onProgress, timeoutMs, sandbox }) {
  const work = plan[index];
  onProgress?.(`${baseName(work.file)}:${mutation.line} ${mutation.description}${sandbox ? ' [sandbox]' : ''}`);

  const file = sandbox ? join(sandbox.dir, relPosix(root, work.file)) : work.file;
  const outcome = await judgeMutation({
    root: sandbox ? sandbox.dir : root,
    file,
    command: work.effective,
    mutation,
    timeoutMs,
  });
  work.results.set(mutation.id, outcome);
}

/**
 * Turn a plan's result map into the same shape `auditFile` returns.
 *
 * Results are assembled in the original mutation order, not completion order, so the
 * report is identical whether the audit ran in one worker or eight.
 */
export function finalizePlan(plan) {
  return plan.map((work) => {
    const results = work.picked.map((mutation) => ({
      mutation,
      ...(work.results.get(mutation.id) ?? { verdict: 'SKIPPED', reason: 'the mutation was not run' }),
    }));

    const survivors = results.filter((r) => r.verdict === 'SURVIVED');
    const killed = results.filter((r) => r.verdict === 'KILLED');
    const errored = results.filter((r) => r.verdict === 'ERRORED');
    const skipped = results.filter((r) => r.verdict === 'SKIPPED');
    const score = killed.length + survivors.length === 0
      ? null
      : killed.length / (killed.length + survivors.length);

    return {
      file: work.file,
      total: results.length,
      available: work.all.length,
      killed: killed.length,
      survived: survivors.length,
      errored: errored.length,
      skipped: skipped.length,
      skippedReason: skipped[0]?.reason,
      score,
      survivors,
      results,
    };
  });
}

/**
 * Create and validate sandbox copies. Returns [] when sandboxing is not viable, and
 * the caller falls back to the sequential in-place path.
 */
async function trySandboxes({ root, count, command }) {
  const made = [];
  try {
    for (let i = 0; i < count; i += 1) made.push(await createSandbox(root));

    // Each copy must be able to run the full suite before any mutant result from it
    // can be believed. A suite that is red in the copy would report every mutation as
    // killed, which reads as a flawless test suite.
    if (command) {
      const checks = await Promise.all(made.map((s) => run(command, s.dir, 180_000)));
      if (!checks.every((c) => c.ok)) throw new Error('a sandbox copy could not run the suite');
    }
    return made;
  } catch {
    for (const sandbox of made) {
      await rm(sandbox.base, { recursive: true, force: true }).catch(() => {});
      unregisterSandbox(sandbox.base);
    }
    return [];
  }
}

async function createSandbox(root) {
  const base = await mkdtemp(join(tmpdir(), 'crucible-sandbox-'));
  registerSandbox(base);

  try {
    const dir = join(base, 'work');
    await cp(root, dir, {
      recursive: true,
      filter: (src) => {
        const rel = relative(root, src);
        if (!rel) return true;
        const first = rel.split(sep)[0];
        return !SANDBOX_SKIP.has(first);
      },
    });

    // The project's own installed binaries are what make a run honest. Link them
    // rather than copying; a missing node_modules stays missing, so the sandbox
    // health check above fails and the sequential path is used.
    const modules = join(root, 'node_modules');
    if (existsSync(modules)) {
      await symlink(modules, join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    return { base, dir };
  } catch (error) {
    await rm(base, { recursive: true, force: true }).catch(() => {});
    unregisterSandbox(base);
    throw error;
  }
}
