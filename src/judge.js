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
 * Audit one source file: try each mutation, count survivors.
 * @param {object} opts
 * @param {string} opts.root
 * @param {string} opts.file
 * @param {string} opts.command
 * @param {number} [opts.maxMutations]  cap work per file
 * @param {(msg: string) => void} [opts.onProgress]
 */
export async function auditFile({ root, file, command, maxMutations = 12, timeoutMs = 120_000, onProgress }) {
  const source = await readFile(file, 'utf8');
  const all = mutationsFor(source, file);

  // Prefer high-signal operators, then take an even sample so we spread across the file.
  const priority = { comparison: 0, boolean: 1, return: 2, arithmetic: 3, number: 4 };
  const ranked = [...all].sort((a, b) => (priority[a.kind] ?? 9) - (priority[b.kind] ?? 9));

  let picked;
  if (ranked.length <= maxMutations) {
    picked = ranked;
  } else {
    const step = ranked.length / maxMutations;
    picked = Array.from({ length: maxMutations }, (_, i) => ranked[Math.floor(i * step)]);
  }

  const results = [];
  for (const mutation of picked) {
    onProgress?.(`${file.split('/').pop()}:${mutation.line} ${mutation.description}`);
    const outcome = await judgeMutation({ root, file, command, mutation, timeoutMs });
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
    killed: killed.length,
    survived: survivors.length,
    errored: errored.length,
    score,
    survivors,
    results,
  };
}
