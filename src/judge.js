/**
 * The judge: run a project's test suite against mutated source and classify.
 *
 * Terminology matters for the report to be honest:
 *   KILLED    — suite failed after mutation. The test caught the break. Good.
 *   SURVIVED  — suite still passed. The test does not assert this behaviour.
 *   UNTESTED  — no test references this file at all. Not the same thing.
 *   ERRORED   — mutation produced code that will not run. Inconclusive, excluded.
 *
 * Only SURVIVED is evidence of a fake test.
 */

import { exec } from 'node:child_process';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { mutationsFor, applyMutation } from './mutate.js';

/** Run a shell command in a directory, capturing output. Never throws. */
export function run(command, cwd, timeoutMs = 120_000) {
  return new Promise((resolvePromise) => {
    const started = Date.now();

    // NODE_TEST_CONTEXT is set when this process is itself a test child. Leaving it
    // in place makes any nested `node --test` silently skip its files, so every
    // mutation would look like it survived. Strip it before shelling out.
    const env = { ...process.env, CI: '1' };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_V8_COVERAGE;

    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env },
      (error, stdout, stderr) => {
        resolvePromise({
          ok: !error,
          code: error?.code ?? 0,
          timedOut: Boolean(error?.killed),
          ms: Date.now() - started,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      });
  });
}

/**
 * Narrow the test command to only the files that cover this source.
 *
 * On a project where the full suite takes 30 seconds, running it once per mutation
 * makes a 12-mutation audit take six minutes. Most of that is tests that cannot
 * possibly notice the mutation.
 *
 * We build a runner-specific command for just the covering test files, and fall
 * back to the full command when we cannot express it safely.
 *
 * @param {object} opts
 * @param {string} opts.command     the project's full test command
 * @param {string[]} [opts.testFiles] absolute paths of covering tests
 * @param {string} opts.root
 * @returns {string} the command to use
 */
export function narrowCommand({ command, testFiles, root }) {
  if (!testFiles || testFiles.length === 0) return command;
  // Too many files means the whole suite anyway; keep the proven full command.
  if (testFiles.length > 6) return command;

  const rels = testFiles.map((f) => f.replace(root + '/', '')).filter(Boolean);
  if (rels.length === 0) return command;

  const quoted = rels.map((r) => JSON.stringify(r)).join(' ');

  if (command.includes('vitest')) return `npx --no-install vitest run ${quoted} --reporter=basic`;
  if (command.includes('jest')) return `npx --no-install jest ${quoted} --ci`;
  if (command.includes('node --test')) return `node --test ${quoted}`;

  // pytest, go, cargo, swift, xcodebuild: keep the full command. Narrowing those
  // safely is runner-specific and getting it wrong produces false survivors.
  return command;
}

/**
 * Mutate one file and see whether the suite notices.
 *
 * The file is restored in a finally block: a crashed run must never leave the
 * user's working tree modified. This is the single most important safety
 * property of the tool.
 *
 * @param {object} opts
 * @param {string} opts.root
 * @param {string} opts.file            absolute path to the source file
 * @param {string} opts.command         test command
 * @param {import('./mutate.js').Mutation} opts.mutation
 * @param {number} [opts.timeoutMs]
 */
export async function judgeMutation({ root, file, command, mutation, timeoutMs = 120_000 }) {
  const original = await readFile(file, 'utf8');

  try {
    await writeFile(file, applyMutation(original, mutation), 'utf8');
    const result = await run(command, root, timeoutMs);

    if (result.timedOut) return { verdict: 'ERRORED', reason: 'timeout', ms: result.ms };

    return {
      verdict: result.ok ? 'SURVIVED' : 'KILLED',
      ms: result.ms,
      output: result.ok ? '' : (result.stdout + result.stderr).slice(-2000),
    };
  } finally {
    await writeFile(file, original, 'utf8');
  }
}

/**
 * Verify the baseline: the suite must pass before any mutation, otherwise every
 * result is meaningless (we would report SURVIVED for a suite that is already red).
 */
export async function baseline({ root, command, timeoutMs = 180_000 }) {
  const result = await run(command, root, timeoutMs);
  return {
    green: result.ok,
    ms: result.ms,
    output: (result.stdout + result.stderr).slice(-4000),
  };
}

/**
 * Choose which mutations to run.
 *
 * The rule is proportional stratified sampling, and it exists because two simpler
 * approaches both lied.
 *
 *   Priority only: 67% reported on a file whose true score was 44%. `number`
 *   mutations sort last and got dropped, and those survive most often.
 *
 *   One-per-kind: still 67%, because one number mutation out of ten is not a
 *   representative sample of numbers, while four arithmetic mutations out of nine
 *   over-weights the operator that dies easily.
 *
 * So each operator kind gets slots in proportion to how many of it exist, every
 * kind is guaranteed at least one slot when it is present, and within a kind the
 * picks spread across the file by line.
 *
 * @param {import('./mutate.js').Mutation[]} mutations
 * @param {number} max
 * @returns {import('./mutate.js').Mutation[]}
 */
export function selectMutations(mutations, max) {
  if (mutations.length <= max) return mutations;

  const byKind = new Map();
  for (const m of mutations) {
    if (!byKind.has(m.kind)) byKind.set(m.kind, []);
    byKind.get(m.kind).push(m);
  }

  const total = mutations.length;
  /** @type {{ kind: string, slots: number, list: any[] }[]} */
  const groups = [...byKind.entries()].map(([kind, list]) => ({
    kind,
    list: [...list].sort((a, b) => a.line - b.line),
    slots: Math.max(1, Math.round((list.length / total) * max)),
  }));

  // Never allocate more slots than the cap allows; trim the largest groups first.
  let allocated = groups.reduce((n, g) => n + g.slots, 0);
  while (allocated > max) {
    groups.sort((a, b) => b.slots - a.slots);
    const biggest = groups[0];
    if (biggest.slots <= 1) break;
    biggest.slots -= 1;
    allocated -= 1;
  }

  // Give leftover slots back to the kinds with the most unreached members.
  let remaining = max - allocated;
  if (remaining > 0) {
    const order = [...groups].sort((a, b) => (b.list.length / b.slots) - (a.list.length / a.slots));
    let i = 0;
    while (remaining > 0 && order.length > 0) {
      const g = order[i % order.length];
      if (g.slots < g.list.length) {
        g.slots += 1;
        remaining -= 1;
      }
      i += 1;
      if (i > max * 4) break;
    }
  }

  const picked = [];
  for (const group of groups) {
    pickSpread(group.list, group.slots, picked);
  }

  return picked.slice(0, max);
}

/**
 * Take `slots` items from a line-sorted list, spread evenly across it.
 * Taking the first N would only ever test the top of the file.
 */
function pickSpread(list, slots, into) {
  if (slots <= 0 || list.length === 0) return;
  if (list.length <= slots) {
    into.push(...list);
    return;
  }

  for (let i = 0; i < slots; i += 1) {
    const idx = Math.floor((i * (list.length - 1)) / Math.max(1, slots - 1));
    into.push(list[idx]);
  }
}

/**
 * Audit one source file: try each mutation, count survivors.
 * @param {object} opts
 * @param {string} opts.root
 * @param {string} opts.file
 * @param {string} opts.command
 * @param {number} [opts.maxMutations]  cap work per file
 * @param {'logic'|'strict'} [opts.profile]
 * @param {(msg: string) => void} [opts.onProgress]
 */
export async function auditFile({ root, file, command, maxMutations = 12, profile = 'logic', testFiles, timeoutMs = 120_000, onProgress }) {
  const source = await readFile(file, 'utf8');
  const all = mutationsFor(source, file, { profile });
  const picked = selectMutations(all, maxMutations);

  // Run only the tests that cover this file. On a large project this is the
  // difference between a 6-minute audit and a 30-second one.
  const effective = narrowCommand({ command, testFiles, root });

  const results = [];
  for (const mutation of picked) {
    onProgress?.(`${file.split('/').pop()}:${mutation.line} ${mutation.description}`);
    const outcome = await judgeMutation({ root, file, command: effective, mutation, timeoutMs });
    results.push({ mutation, ...outcome });
  }

  const survivors = results.filter((r) => r.verdict === 'SURVIVED');
  const killed = results.filter((r) => r.verdict === 'KILLED');
  const errored = results.filter((r) => r.verdict === 'ERRORED');

  const score = killed.length + survivors.length === 0
    ? null
    : killed.length / (killed.length + survivors.length);

  return {
    file,
    total: results.length,
    available: all.length,
    killed: killed.length,
    survived: survivors.length,
    errored: errored.length,
    score,
    survivors,
    results,
  };
}
