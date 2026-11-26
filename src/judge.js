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
import { readFile, writeFile } from 'node:fs/promises';
import { rmSync, writeFileSync } from 'node:fs';
import { mutationsFor, applyMutation } from './mutate.js';
import { relPosix, baseName } from './paths.js';

/**
 * Files whose original bytes are currently overwritten on disk, and temporary
 * sandboxes that still need removing.
 *
 * The `finally` block in judgeMutation restores a file on every normal and error
 * path, but a SIGINT (the thing a user presses when an audit is slow) terminates
 * the process without running it. For a tool that rewrites source in place, that
 * leaves the user's file mutated — the worst failure mode this program has.
 *
 * These registries exist so the CLI can restore and clean up from a signal
 * handler before exiting.
 */
const inFlight = new Map();
const sandboxes = new Set();
const tempFiles = new Set();

export function trackInFlight(file, original) {
  inFlight.set(file, original);
}

export function clearInFlight(file) {
  inFlight.delete(file);
}

export function registerSandbox(dir) {
  sandboxes.add(dir);
}

export function unregisterSandbox(dir) {
  sandboxes.delete(dir);
}

/** Temporary probe files written into the user's tree; removed on every exit path. */
export function registerTempFile(path) {
  tempFiles.add(path);
}

export function unregisterTempFile(path) {
  tempFiles.delete(path);
}

export function cleanupTempFilesSync() {
  let removed = 0;
  for (const path of tempFiles) {
    try {
      rmSync(path, { force: true });
      removed += 1;
    } catch { /* best effort */ }
  }
  tempFiles.clear();
  return removed;
}

/**
 * Restore every file currently mutated, synchronously.
 *
 * Synchronous on purpose: signal handlers and the `exit` event cannot await an
 * async write. Returns how many files were restored, for the caller's message.
 */
export function restoreInFlightSync() {
  let restored = 0;
  for (const [file, original] of inFlight) {
    try {
      writeFileSync(file, original, 'utf8');
      restored += 1;
    } catch { /* best effort — the original is also in the caller's memory */ }
  }
  inFlight.clear();
  return restored;
}

/** Remove every temporary sandbox, synchronously. */
export function cleanupSandboxesSync() {
  let removed = 0;
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch { /* best effort */ }
  }
  sandboxes.clear();
  return removed;
}

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
  const base = addFailFast(command);
  if (!testFiles || testFiles.length === 0) return base;

  const rels = testFiles.map((f) => relPosix(root, f)).filter(Boolean);
  if (rels.length === 0) return base;

  // Narrow even when many files cover the source: 17 files out of axios's 185 is
  // still a 10x reduction. The old cap of 6 meant every file in a large project fell
  // back to the full suite, which is why one axios file took minutes.
  //
  // Above 40 the command starts exceeding practical argv limits and the source is
  // usually a shared utility, so the whole suite is the honest choice.
  if (rels.length > 40) return base;

  const quoted = rels.map((r) => JSON.stringify(r)).join(' ');

  if (/node_modules\/\.bin\/vitest|vitest run/.test(command)) {
    return addFailFast(`./node_modules/.bin/vitest run ${quoted}`);
  }
  if (/node_modules\/\.bin\/jest|jest --ci/.test(command)) {
    return addFailFast(`./node_modules/.bin/jest ${quoted} --ci`);
  }
  if (/node_modules\/\.bin\/ava|\bava\b/.test(command)) {
    return addFailFast(`./node_modules/.bin/ava ${quoted}`);
  }
  // `node --test` with a loader or import hook (`--import tsx`) only understands
  // the project's files with that flag, so the narrowed command must keep its
  // flags. The command's own positional test paths/globs are replaced by the
  // covering files, never appended to them.
  const nodeTest = command.match(/^(.*?\bnode)\s+(.*?)--test\b(.*)$/);
  if (nodeTest) {
    const prefix = `${nodeTest[1]} ${nodeTest[2]}`.trim();
    const tailTokens = nodeTest[3].trim() ? nodeTest[3].trim().split(/\s+/) : [];

    // Flags that take a separate value: keep the value with its flag.
    const valueFlags = new Set([
      '--test-reporter', '--test-reporter-destination', '--test-concurrency',
      '--test-name-pattern', '--test-skip-pattern', '--test-timeout',
      '--import', '--loader', '--experimental-loader', '--conditions',
      '--require', '--env-file',
    ]);
    const kept = [];
    for (let i = 0; i < tailTokens.length; i += 1) {
      const token = tailTokens[i];
      if (!token.startsWith('-')) continue; // a test path/glob: replaced
      kept.push(token);
      if (valueFlags.has(token) && i + 1 < tailTokens.length && !tailTokens[i + 1].startsWith('-')) {
        kept.push(tailTokens[i + 1]);
        i += 1;
      }
    }

    return `${prefix} --test${kept.length > 0 ? ` ${kept.join(' ')}` : ''} ${quoted}`;
  }

  // pytest accepts test file paths directly; narrowing this way is the same
  // contract as vitest's and turns a full-suite-per-mutation audit on a large
  // Python project into a handful of files.
  if (/python3? -m pytest|(^|\s)pytest\b/.test(command)) {
    return addFailFast(`${command} ${quoted}`);
  }

  // Go: a mutation in a package can only be noticed by that package's tests, so
  // narrow to the directories containing the covering `_test.go` files.
  if (/\bgo test\b/.test(command)) {
    const dirs = [...new Set(rels.map((rel) => {
      const cut = rel.lastIndexOf('/');
      return cut === -1 ? '.' : rel.slice(0, cut);
    }))];
    if (dirs.length <= 40) {
      const targets = dirs.map((dir) => JSON.stringify(dir === '.' ? '.' : `./${dir}`)).join(' ');
      return `go test -failfast ${targets}`;
    }
    return base;
  }

  // Cargo: only integration test targets in tests/ can be named; unit tests inside
  // src/ belong to the crate target and cannot be selected this way.
  if (/\bcargo test\b/.test(command)) {
    const inTests = rels.filter((rel) => rel.startsWith('tests/'));
    const targets = [...new Set(inTests.map((rel) => rel.slice('tests/'.length).replace(/\.[^.]+$/, '')))];
    if (targets.length > 0 && targets.length === rels.length && targets.length <= 20) {
      return targets.map((name) => `cargo test --test ${JSON.stringify(name)}`).join(' && ');
    }
    return base;
  }

  // swift, xcodebuild and anything unrecognised: keep the full command. A guessed
  // filter that matches nothing returns green and reports every mutant as survived.
  return base;
}

/**
 * Stop at the first failure.
 *
 * A mutation is judged by whether the suite fails at all, so there is nothing to
 * learn from the remaining tests once one has failed. On a project with 400 tests
 * this turns most mutation runs from a full suite into a fraction of one.
 *
 * Each runner spells it differently; the command is returned unchanged when the
 * runner is not recognised rather than guessing a flag that would error.
 */
export function addFailFast(command) {
  if (/--bail|--fail-fast|-x\b|-failfast/.test(command)) return command;

  if (/node --test/.test(command)) return command; // node:test has no bail flag
  if (/vitest|crucible|jest/.test(command)) {
    if (/vitest/.test(command)) return `${command} --bail=1`;
    if (/jest/.test(command)) return `${command} --bail=1`;
  }
  if (/\bava\b/.test(command)) return `${command} --fail-fast`;
  if (/\bmocha\b/.test(command)) return `${command} --bail`;
  if (/\btap\b/.test(command)) return `${command} --bail`;
  if (/python3? -m pytest|pytest/.test(command)) {
    return /-x\b/.test(command) ? command : `${command} -x`;
  }
  // Word boundary matters: "cargo test" contains the substring "go test".
  if (/\bgo test\b/.test(command)) return `${command} -failfast`;
  // cargo test already stops at the first failing test binary by default; there is
  // no flag to add, and `-failfast` (a Go flag) would be rejected.
  if (/\bcargo test\b/.test(command)) return command;

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

  // Register the original BEFORE the write: a signal between the two would
  // otherwise leave the mutated bytes on disk with nothing recorded to restore.
  trackInFlight(file, original);
  try {
    await writeFile(file, applyMutation(original, mutation), 'utf8');
  } catch (error) {
    clearInFlight(file);
    // A read-only file, a file owned by another user, a full disk. Writing is the
    // one operation this tool cannot fake, and crashing with a stack trace tells
    // the user nothing.
    return {
      verdict: 'SKIPPED',
      reason: error.code === 'EACCES' || error.code === 'EPERM'
        ? 'file is not writable, so it cannot be mutated in place'
        : `could not write the mutation: ${error.message}`,
      ms: 0,
    };
  }

  try {
    const result = await run(command, root, timeoutMs);

    if (result.timedOut) return { verdict: 'ERRORED', reason: 'timeout', ms: result.ms };

    return {
      verdict: result.ok ? 'SURVIVED' : 'KILLED',
      ms: result.ms,
      output: result.ok ? '' : (result.stdout + result.stderr).slice(-2000),
    };
  } finally {
    // Restore even when the run threw. A crashed run must never leave the user's
    // working tree modified.
    await writeFile(file, original, 'utf8').catch(() => {});
    clearInFlight(file);
  }
}

/**
 * Verify the baseline: the suite must pass before any mutation, otherwise every
 * result is meaningless (we would report SURVIVED for a suite that is already red).
 *
 * Three failure shapes, and they need different advice:
 *
 *   missing       the runner is not installed, or dependencies are not.
 *   environmental the tests themselves pass, but the run exits non-zero because of
 *                 something outside the code: a missing browser, an unreachable
 *                 host, a native addon that will not load. axios hits this: 2554
 *                 tests pass and vitest still exits 1 because Playwright's Firefox
 *                 and WebKit binaries are absent. Saying "suite is red" sends the
 *                 user looking for a broken test that does not exist.
 *   red           actual test failures.
 */
export async function baseline({ root, command, timeoutMs = 180_000 }) {
  const result = await run(command, root, timeoutMs);
  const output = result.stdout + result.stderr;

  const missing = result.code === 127
    || /command not found|No module named|not found in \$PATH|cannot find package/i.test(output)
    // `npx --no-install` refuses when the binary is not in node_modules, which is
    // what a fresh clone looks like before `npm install`.
    || /npx canceled due to missing packages|could not determine executable|ENOENT.*spawn/i.test(output);

  if (missing) {
    return {
      green: false,
      missing: true,
      ms: result.ms,
      command,
      output: output.slice(-1500),
      hint: /missing packages/i.test(output)
        ? `dependencies are not installed. Run the project's install step (npm install / pnpm install / pip install -e .) and try again.`
        : `the test runner is not installed: \`${command}\` could not run. Install its dependencies, then try again.`,
    };
  }

  if (!result.ok) {
    const environmental = environmentalNoise(output);
    if (environmental) {
      return {
        green: false,
        environmental: true,
        ms: result.ms,
        command,
        detail: environmental,
        hint: `the tests themselves passed, but the run failed for an environment reason: ${environmental.what}. ${environmental.fix}`,
        output: output.slice(-1500),
      };
    }
  }

  return {
    green: result.ok,
    missing: false,
    ms: result.ms,
    output: output.slice(-4000),
  };
}

/**
 * Recognise a non-zero exit that is not a test failure.
 *
 * The rule: the output must show passing tests, no failing tests, and a known
 * environment error. Only then is it safe to say the code is fine.
 *
 * @returns {{ what: string, fix: string } | null}
 */
export function environmentalNoise(output) {
  // `[1-9]` matters: "0 passed" means the suite did not run, and an environment
  // error on top of that could be hiding real failures.
  const hasPassed = /\b[1-9]\d*\s+passed\b|\bTests\s+[1-9]\d*\s+passed/i.test(output);
  const hasFailed = /\b[1-9]\d*\s+failed\b|FAIL\s/i.test(output);
  const hasUnhandled = /Unhandled Error|unhandledRejection|uncaught exception/i.test(output);

  if (!hasPassed || hasFailed) return null;

  const known = [
    {
      test: /Executable doesn't exist|browserType\.launch|Please run.*playwright install/i,
      what: 'a browser binary is missing',
      fix: 'Run `npx playwright install` (or the equivalent for this project), then try again.',
    },
    {
      test: /ECONNREFUSED|ENOTFOUND|getaddrinfo|network timeout/i,
      what: 'a network host could not be reached',
      fix: 'Start the required service or run the suite offline, then try again.',
    },
    {
      test: /Cannot find native module|NODE_MODULE_VERSION|invalid ELF header|dlopen/i,
      what: 'a native addon failed to load',
      fix: 'Rebuild the native dependencies for this Node version (npm rebuild), then try again.',
    },
    {
      test: /VITE_|missing env|environment variable .* is not defined/i,
      what: 'an environment variable is missing',
      fix: 'Provide the variable the suite expects, then try again.',
    },
  ];

  if (!hasUnhandled) return null;

  for (const entry of known) {
    if (entry.test.test(output)) return { what: entry.what, fix: entry.fix };
  }

  return {
    what: 'the runner reported an unhandled error while all tests passed',
    fix: 'Read the tail of the run output to see which resource is missing, then try again.',
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
    onProgress?.(`${baseName(file)}:${mutation.line} ${mutation.description}`);
    const outcome = await judgeMutation({ root, file, command: effective, mutation, timeoutMs });
    results.push({ mutation, ...outcome });
  }

  const survivors = results.filter((r) => r.verdict === 'SURVIVED');
  const killed = results.filter((r) => r.verdict === 'KILLED');
  const errored = results.filter((r) => r.verdict === 'ERRORED');
  const skipped = results.filter((r) => r.verdict === 'SKIPPED');

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
    skipped: skipped.length,
    skippedReason: skipped[0]?.reason,
    score,
    survivors,
    results,
  };
}
