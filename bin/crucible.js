#!/usr/bin/env node
/**
 * crucible — find tests that cannot fail, then pin the values they should assert.
 *
 * Two independent signals, graded by how provable they are:
 *
 *   static  — assertions that are true by construction (certain)
 *   mutation — deliberate breaks the suite did not notice (likely, or suspect
 *              when the tests do pin values and we cannot prove a gap)
 *
 * Commands:
 *   crucible scan [dir]     report findings
 *   crucible fix  [dir]     write regression tests that pin real values
 *   crucible verify [dir]   re-run the audit after a fix
 *   crucible install        copy the agent skill into the agent's skill directory
 */

import { readFile, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir, availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { join, basename, extname } from 'node:path';
import { discover } from '../src/discover.js';
import {
  baseline, run, restoreInFlightSync, cleanupSandboxesSync, cleanupTempFilesSync,
  registerTempFile, unregisterTempFile,
} from '../src/judge.js';
import { buildPlan, executePlan, finalizePlan } from '../src/audit.js';
import { loadCache, saveCache, cacheKey, cacheableResult, isUsableResult } from '../src/cache.js';
import { scanTestSource } from '../src/detect.js';
import { gradeFinding, gradeSurvivor, hasValuePinningAssertions, headline, CONFIDENCE } from '../src/confidence.js';
import { rankSurvivors } from '../src/boundary.js';
import { exportedNames, harvestCallSites, buildProbe, buildValueProbe, parseProbeOutput,
  buildFixTest, placement } from '../src/fix.js';
import { fixBoundaries } from '../src/fix-boundary.js';
import { fixObjectBoundary } from '../src/fix-object.js';
import { nextStepFor, planFor } from '../src/next.js';
import { mapComparisonsToFunctions } from '../src/fix-boundary.js';
import { mayWrite, stamp } from '../src/guard.js';
import { relPosix, toPosix } from '../src/paths.js';
import { installSkill, defaultSkillTargets } from '../src/install.js';

const C = {
  reset: '\u001b[0m', dim: '\u001b[2m', bold: '\u001b[1m',
  red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m',
  cyan: '\u001b[36m', magenta: '\u001b[35m',
};

const argv = process.argv.slice(2);

/**
 * Refuse on an old Node with a sentence, not a stack trace.
 *
 * The code needs Node 20 for stable `node --test` flags and `import.meta`. On 18 it
 * would fail somewhere deep in a module load, and the first thing a stranger sees
 * would be a SyntaxError they cannot act on.
 */
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (Number.isFinite(nodeMajor) && nodeMajor < 20) {
  console.error(
    `crucible needs Node 20 or newer. You have ${process.version}.\n`
    + 'Upgrade Node (nvm install 20, or https://nodejs.org), then try again.',
  );
  process.exit(2);
}

// --version before anything else: an issue report needs it.
let VERSION = 'unknown';
try {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  VERSION = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
} catch { /* running from somewhere without package.json */ }

const ENV_LINE = `crucible ${VERSION} | node ${process.version} | ${process.platform}`;

if (argv.includes('--version') || argv.includes('-v')) {
  console.log(ENV_LINE);
  process.exit(0);
}

/**
 * A way out when the tool cannot work it out itself.
 *
 * Only shown when crucible is the one that does not know — an unrecognised language,
 * an unfamiliar test layout, a crash. Never when the problem is the user's own
 * failing suite, because that is not our bug and pointing at an issue tracker would
 * just be noise.
 */
const ISSUE_URL = 'https://github.com/aoshuhang/crucible/issues/new?template=wrong-result.md';

function reportHint(what) {
  return `${C.dim}${what}${C.reset}\n  ${C.dim}report it:${C.reset} ${C.cyan}${ISSUE_URL}${C.reset}\n  ${C.dim}include this line:${C.reset} ${ENV_LINE}`;
}

/**
 * Restore mutated source and remove temporary sandboxes when the user interrupts.
 *
 * A SIGINT normally terminates the process without running `finally` blocks. For a
 * tool that rewrites source in place, Ctrl-C mid-audit would leave the user's file
 * mutated — the one outcome this program must never produce. The restore must be
 * synchronous: async work is not guaranteed to finish after a signal.
 */
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    const restored = restoreInFlightSync();
    cleanupSandboxesSync();
    cleanupTempFilesSync();
    if (restored > 0) {
      console.error(`\n${C.yellow}crucible: interrupted — restored ${restored} source file${restored === 1 ? '' : 's'}.${C.reset}`);
    }
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}
process.on('exit', () => {
  restoreInFlightSync();
  cleanupSandboxesSync();
  cleanupTempFilesSync();
});
const flags = new Set(argv.filter((a) => a.startsWith('-')));
const positional = argv.filter((a) => !a.startsWith('-'));
// No command prints help. Defaulting to `scan` meant a curious first run spent a
// minute mutating whatever directory you happened to be in.
const command = positional[0] ?? null;
const target = positional[1] ?? process.cwd();

const asJson = flags.has('--json');
const verbose = flags.has('--verbose');
const noMutation = flags.has('--no-mutation');
const force = flags.has('--force');
const allowEnvNoise = flags.has('--allow-env-noise');
const noCache = flags.has('--no-cache');

/**
 * Parse a `--flag=value` that must be a positive integer.
 *
 * `--limit=abc` used to pass `NaN` to `slice`, which returns an empty array: the
 * audit silently covered zero files and the report looked clean. A typo must be an
 * error, not a false all-clear.
 */
function positiveInt(flag, fallback) {
  const arg = argv.find((a) => a.startsWith(`${flag}=`));
  if (!arg) return fallback;
  const raw = arg.slice(flag.length + 1);
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) {
    console.error(`${flag} expects a positive integer, got "${raw}"`);
    process.exit(1);
  }
  return n;
}

const maxFiles = positiveInt('--limit', 12);
// Each job is a temporary sandbox copy, so more than the core count buys nothing.
// `--jobs=1` keeps the in-place path when a copy is undesirable.
const jobs = positiveInt('--jobs', Math.min(4, Math.max(1, availableParallelism())));
// CI gate for the mutation score. Absent means "do not gate".
let failUnder = null;
if (argv.some((a) => a.startsWith('--fail-under='))) {
  const raw = argv.find((a) => a.startsWith('--fail-under=')).slice('--fail-under='.length);
  const n = Number(raw);
  if (!/^\d+(?:\.\d+)?$/.test(raw) || !Number.isFinite(n) || n < 0 || n > 100) {
    console.error(`--fail-under expects a percentage between 0 and 100, got "${raw}"`);
    process.exit(1);
  }
  failUnder = n;
}

const profileArg = argv.find((a) => a.startsWith('--profile='));
const profile = profileArg ? profileArg.split('=')[1] : 'logic';
if (!['logic', 'strict'].includes(profile)) {
  console.error(`unknown profile: ${profile} (expected logic or strict)`);
  process.exit(1);
}

const say = (...parts) => { if (!asJson) console.log(...parts); };

/** The neighbouring operator, for readable report text. */
function flipOf(op) {
  return { '<': '<=', '<=': '<', '>': '>=', '>=': '>', '===': '!==', '!==': '===', '==': '!=', '!=': '==' }[op] ?? op;
}

/** Static pass over every test file. */
async function staticPass(project) {
  const findings = [];

  for (const testFile of project.testFiles) {
    let text;
    try {
      text = await readFile(testFile, 'utf8');
    } catch {
      continue;
    }

    const rel = relPosix(project.root, testFile);
    for (const f of scanTestSource(text, rel)) {
      findings.push({ ...f, confidence: gradeFinding(f) });
    }
  }

  return findings;
}

/** Mutation pass over covered source files, with cache and optional parallelism. */
async function mutationPass(project, { onProgress } = {}) {
  // Sorted before slicing: `--limit` must pick the same files on every machine,
  // otherwise a CI run and a local run audit different subsets.
  const covered = [...project.covers.entries()]
    .filter(([, tests]) => tests.length > 0)
    .map(([file, testFiles]) => ({ file, testFiles }))
    // Byte order, not locale order: `--limit` must select the same files in CI and
    // locally, and localeCompare depends on the machine's ICU collation.
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .slice(0, maxFiles);

  if (covered.length === 0) return [];

  // An env-noise run audits a suite that did not fully start; caching those results
  // would let a later clean run reuse them.
  const useCache = !noCache && !allowEnvNoise;
  const cache = await loadCache(project.root, { enabled: useCache });
  const keys = new Map();
  const cachedResults = new Map();
  const misses = [];

  for (const target of covered) {
    const source = await readFile(target.file, 'utf8');
    const testContents = await Promise.all(target.testFiles.map(async (tf) => {
      try { return await readFile(tf, 'utf8'); } catch { return ''; }
    }));
    const key = cacheKey({
      source,
      testContents,
      command: project.runner.command,
      profile,
      maxMutations: 12,
    });
    keys.set(target.file, key);

    const hit = cache.entries[key];
    if (isUsableResult(hit)) cachedResults.set(target.file, hit);
    else misses.push(target);
  }

  const fresh = new Map();
  if (misses.length > 0) {
    const plan = await buildPlan({
      root: project.root,
      targets: misses,
      command: project.runner.command,
      profile,
      maxMutations: 12,
    });
    await executePlan({
      root: project.root,
      plan,
      command: project.runner.command,
      jobs,
      onProgress,
    });

    for (const result of finalizePlan(plan)) {
      fresh.set(result.file, result);
      if (useCache) cache.entries[keys.get(result.file)] = cacheableResult(result);
    }
    if (useCache) await saveCache(cache);
  }

  const files = [];
  for (const { file: sourceFile, testFiles } of covered) {
    const result = cachedResults.get(sourceFile) ?? fresh.get(sourceFile);
    if (!result) continue;
    const cached = cachedResults.has(sourceFile);

    // What do the covering tests look like? This decides likely vs suspect.
    let testSource = '';
    for (const tf of testFiles) {
      try { testSource += await readFile(tf, 'utf8'); } catch { /* ignore */ }
    }
    const grade = gradeSurvivor({ testSource, hasTest: true });

    // Boundary survivors are the most actionable finding we have: each one is a
    // missing edge case, not a vague complaint about test quality.
    const sourceLines = (await readFile(sourceFile, 'utf8')).split('\n');
    const ranked = rankSurvivors(result.survivors, sourceLines);

    files.push({
      ...result,
      relFile: relPosix(project.root, sourceFile),
      testFiles: testFiles.map((t) => relPosix(project.root, t)),
      grade,
      cached,
      survivorFindings: ranked.filter((s) => s.boundary || s.threshold).map((s) => ({
        id: 'untested-boundary',
        file: relPosix(project.root, sourceFile),
        line: s.mutation.line,
        kind: 'boundary',
        snippet: s.described,
        why: `no test covers the edge of this comparison: flipping ${s.mutation.original} to ${flipOf(s.mutation.original)} went unnoticed`,
        fix: s.suggestion,
        confidence: CONFIDENCE.LIKELY,
      })),
    });
  }

  return files;
}

/**
 * Fast path: read the test files and report what cannot fail.
 *
 * No test is executed, so this finishes in well under a second even on a large
 * project — fast enough to run the moment you finish writing a test, which is when
 * the feedback is actually useful. It only sees what can be proven by reading:
 * assertions that are true by construction, tests with no assertion at all,
 * self-mocking, skipped tests.
 *
 * It cannot see a boundary that no test supplies; that needs `scan`.
 */
async function cmdCheck() {
  const project = await discover(target);
  const findings = await staticPass(project);

  const certain = findings.filter((f) => f.confidence === CONFIDENCE.CERTAIN);
  const suspect = findings.filter((f) => f.confidence === CONFIDENCE.SUSPECT);

  if (asJson) {
    return console.log(JSON.stringify({
      root: project.root,
      target: project.targetedFile ?? null,
      mode: 'static',
      testFiles: project.testFiles.length,
      unsupported: project.unsupported ?? [],
      workspaces: (project.workspaces ?? []).map((dir) => relPosix(project.root, dir)),
      summary: { cannotFail: certain.length, worthChecking: suspect.length },
      findings: findings.map((f) => ({ ...f, next: nextStepFor(f, { root: project.root }) })),
    }, null, 2));
  }

  say(`${C.bold}crucible check${C.reset} ${C.dim}${project.root}${C.reset}`);
  say(`  ${project.testFiles.length} test file${project.testFiles.length === 1 ? '' : 's'}, `
    + `${project.sourceFiles.length} source file${project.sourceFiles.length === 1 ? '' : 's'} ${C.dim}(no tests executed)${C.reset}`);
  if (project.unsupported?.length) {
    const total = project.unsupported.reduce((n, item) => n + item.count, 0);
    const list = project.unsupported.map((item) => `${item.ext} (${item.count})`).join(', ');
    say(`  ${C.yellow}skipped ${total} file${total === 1 ? '' : 's'} in unsupported formats: ${list}${C.reset}`);
    say(`  ${C.dim}crucible cannot parse these, so they and their tests are outside this report.${C.reset}`);
  }
  say('');

  // "Nothing to report" and "I could not find your tests" look identical otherwise,
  // and the second one told a Java project its tests were fine. Say which it is.
  if (project.testFiles.length === 0) {
    say(`${C.yellow}No test files were found.${C.reset}`);
    if (project.sourceFiles.length === 0) {
      say(`${C.dim}Nothing in ${project.root} looks like JavaScript, TypeScript, Python, Go, Rust or Swift source.${C.reset}`);
      say(reportHint('If it is a language crucible should support, that is worth knowing.'));
    } else {
      say(`${C.dim}${project.sourceFiles.length} source file${project.sourceFiles.length === 1 ? '' : 's'} found, but nothing matched a test naming convention`
        + ` (*.test.js, *.spec.ts, test_*.py, *_test.go, *Tests.swift, or a tests/ directory).${C.reset}`);
      say(reportHint('If this project does have tests, the layout is one crucible does not recognise.'));
    }
    return;
  }

  if (certain.length === 0 && suspect.length === 0) {
    say(`${C.green}No test that cannot fail.${C.reset}`);
    say(`${C.dim}This is the static view. Run \`crucible scan\` to check for untested boundaries.${C.reset}`);
    return;
  }

  if (certain.length > 0) {
    say(`${C.red}${C.bold}Cannot fail${C.reset} ${C.dim}(${certain.length})${C.reset}`);
    for (const f of certain) {
      say(`  ${C.red}${f.file}:${f.line}${C.reset} ${C.dim}${f.id}${C.reset}`);
      say(`    ${f.snippet}`);
      say(`    ${C.dim}→ ${f.fix}${C.reset}`);
    }
    say('');
  }

  if (suspect.length > 0) {
    say(`${C.dim}${C.bold}Worth a look${C.reset} ${C.dim}(${suspect.length})${C.reset}`);
    for (const f of suspect.slice(0, 5)) {
      say(`  ${C.dim}${f.file}:${f.line} ${f.id}${C.reset}`);
    }
    if (suspect.length > 5) say(`  ${C.dim}... ${suspect.length - 5} more${C.reset}`);
    say('');
  }

  say(`${C.bold}${certain.length} test${certain.length === 1 ? '' : 's'} cannot fail${C.reset}`
    + (suspect.length ? `, ${suspect.length} to review` : ''));

  // A non-zero exit when something certainly cannot fail, so this works as a
  // pre-commit hook or a CI step without parsing the output.
  if (certain.length > 0) process.exitCode = 1;
}

/**
 * A monorepo root usually has the workspace declaration but not the runner, so the
 * honest answer is the list of package directories to run against.
 */
function workspaceLines(project) {
  if (!project.workspaces?.length) return [];
  const rels = project.workspaces.map((ws) => relPosix(project.root, ws));
  return [
    `This looks like a monorepo: ${rels.length} package${rels.length === 1 ? '' : 's'} declare their own tests.`,
    'Run crucible in each package:',
    ...rels.slice(0, 8).map((rel) => `  npx @hsaohuang/crucible scan ${JSON.stringify(rel)}`),
    ...(rels.length > 8 ? ['  ...'] : []),
  ];
}

async function cmdScan() {
  say(`${C.bold}crucible${C.reset} ${C.dim}${target}${C.reset}`);

  const project = await discover(target);
  if (!project.runner) {
    const msg = 'no test runner detected (looked for package.json test script, vitest, jest, ava, mocha, pytest, go, cargo, swift)';
    const ws = project.workspaces?.map((dir) => relPosix(project.root, dir)) ?? [];
    if (asJson) {
      return console.log(JSON.stringify({
        error: msg,
        workspaces: ws,
        notDetected: 'runner',
        env: ENV_LINE,
      }, null, 2));
    }
    console.error(`${C.red}${msg}${C.reset}`);
    const lines = workspaceLines(project);
    if (lines.length > 0) {
      console.error('');
      for (const line of lines) console.error(`${C.dim}${line}${C.reset}`);
    }
    console.error(reportHint('That means crucible found the project but not how it runs its tests.'));
    process.exitCode = 2;
    return;
  }

  // Files nothing references. Reporting zero findings for a project where nothing
  // is covered would read as "healthy", which is the opposite of the truth.
  const uncovered = [...project.covers.entries()]
    .filter(([, tests]) => tests.length === 0)
    .map(([src]) => relPosix(project.root, src));

  // Static findings need no execution, so report them even if the suite is red.
  const staticFindings = await staticPass(project);

  let mutationFiles = [];
  let base = null;
  let suiteError = null;
  let envNoise = null;

  if (!noMutation) {
    // Before running anything: if the declared runner is not installed, say so with
    // the right install command for this project's package manager. Running it
    // anyway would either fail obscurely or reach into the npx cache.
    if (project.runner.installed === false) {
      const pm = project.packageManager ?? 'npm';
      const install = pm === 'bun' ? 'bun install' : `${pm} install`;
      suiteError = `dependencies are not installed. Run \`${install}\` in ${project.root}, then try again.`;
    } else {
      base = await baseline({ root: project.root, command: project.runner.command });
      if (base.green) {
        mutationFiles = await mutationPass(project, {
          onProgress: (m) => { if (verbose) say(`  ${C.dim}${m}${C.reset}`); },
        });
      } else if (base.missing) {
        suiteError = base.hint ?? 'the test runner could not be started';
      } else if (base.environmental && allowEnvNoise) {
        // The user asked to proceed despite the environment noise. Say what was
        // skipped so the report is not mistaken for a clean run.
        envNoise = base.detail;
        mutationFiles = await mutationPass(project, {
          onProgress: (m) => { if (verbose) say(`  ${C.dim}${m}${C.reset}`); },
        });
      } else if (base.environmental) {
        suiteError = `${base.hint}\n       Re-run with --allow-env-noise to audit anyway; results may miss tests that failed to start.`;
      } else {
        suiteError = 'suite is red before mutation, so mutation results would be meaningless';
      }
    }
  }

  const allFindings = [
    ...staticFindings,
    ...mutationFiles.flatMap((f) => f.survivorFindings),
  ];

  // One finding per source location. A boundary survivor is strictly more
  // specific than a generic "does not check values", so it wins.
  const byLocation = new Map();
  const priority = (f) => (f.kind === 'boundary' ? 3 : f.confidence === 'certain' ? 2 : 1);

  for (const f of allFindings) {
    const key = `${f.file}:${f.line}`;
    const existing = byLocation.get(key);
    if (!existing || priority(f) > priority(existing)) byLocation.set(key, f);
  }

  // Static findings on test files must not collide with source-file findings.
  const deduped = [...byLocation.values()];
  const summary = headline(deduped);

  // Pool the score rather than averaging per-file percentages: a file with one
  // mutation must not weigh the same as a file with fifty.
  const scoredFiles = mutationFiles.filter((f) => f.score !== null);
  const killedTotal = scoredFiles.reduce((n, f) => n + f.killed, 0);
  const survivedTotal = scoredFiles.reduce((n, f) => n + f.survived, 0);
  const pooledScore = killedTotal + survivedTotal === 0
    ? null
    : killedTotal / (killedTotal + survivedTotal);
  const scorePercent = pooledScore === null ? null : Math.round(pooledScore * 100);

  // Exit codes: something certainly wrong (1) is the CI signal; failing to run at
  // all (2) outranks it because the audit's result is not trustworthy.
  if (suiteError) process.exitCode = 2;
  if (summary.fakeTests > 0 && !process.exitCode) process.exitCode = 1;

  // A score gate for CI. `--fail-under=N` is a promise to the build: if no score
  // could be produced (all files skipped, or static-only run), say so instead of
  // silently passing.
  let scoreGate = null;
  let gateFailed = false;
  if (failUnder !== null) {
    if (scorePercent === null) {
      if (noMutation || suiteError) {
        scoreGate = `--fail-under ignored: no mutation score was produced (${noMutation ? 'static-only run' : 'the suite could not be audited'})`;
      } else {
        scoreGate = `--fail-under ${failUnder} failed: no mutation produced a score`;
        gateFailed = true;
        process.exitCode = 1;
      }
    } else if (scorePercent < failUnder) {
      scoreGate = `mutation score ${scorePercent}% is below --fail-under=${failUnder}`;
      gateFailed = true;
      process.exitCode = 1;
    } else {
      scoreGate = `mutation score ${scorePercent}% meets --fail-under=${failUnder}`;
    }
  }

  if (asJson) {
    // Each finding carries the next action, and the run carries an ordered plan.
    // An agent should not have to interpret the report, only execute it.
    //
    // `findings` is the SAME deduped list the summary counts come from; emitting
    // the raw list made the numbers disagree and an agent could not tell which was
    // authoritative.
    const enriched = deduped.map((f) => ({ ...f, next: nextStepFor(f, { root: project.root }) }));

    return console.log(JSON.stringify({
      root: project.root,
      target: project.targetedFile ?? null,
      runner: project.runner.name,
      baselineMs: base?.ms ?? null,
      suiteError,
      suiteChecked: Boolean(base),
      summary,
      mutationScore: scorePercent,
      scoreGate,
      uncovered,
      unsupported: project.unsupported ?? [],
      workspaces: (project.workspaces ?? []).map((dir) => relPosix(project.root, dir)),
      truncated: project.truncated ?? false,
      environmentNoise: envNoise,
      plan: planFor({
        findings: enriched,
        summary,
        // An env-noise run was explicitly allowed to proceed: the suite is not
        // "red" in the plan's sense, so do not tell the agent to fix it first.
        suiteGreen: base ? (base.green || Boolean(envNoise)) : null,
        root: project.root,
      }),
      findings: enriched,
      files: mutationFiles.map((f) => ({
        file: f.relFile,
        score: f.score,
        killed: f.killed,
        survived: f.survived,
        skipped: f.skipped ?? 0,
        skippedReason: f.skippedReason ?? null,
        confidence: f.grade.confidence,
        tests: f.testFiles,
        cached: f.cached ?? false,
      })),
    }, null, 2));
  }

  const stateLabel = !base
    ? ''
    : base.green
      ? ` ${C.dim}(green in ${base.ms}ms)${C.reset}`
      : base.missing
        ? ` ${C.yellow}(runner not found)${C.reset}`
        : base.environmental
          ? ` ${C.yellow}(environment error)${C.reset}`
          : ` ${C.red}(suite is red)${C.reset}`;

  say(`  runner ${C.cyan}${project.runner.name}${C.reset}${stateLabel}`);
  say(`  ${project.sourceFiles.length} source, ${project.testFiles.length} test files`);
  if (suiteError) say(`  ${C.yellow}${suiteError}${C.reset}`);

  // Silence about files crucible cannot parse reads as "those are fine". Say what
  // was skipped and why, so a clean report cannot be mistaken for full coverage.
  if (project.unsupported?.length) {
    const total = project.unsupported.reduce((n, item) => n + item.count, 0);
    const list = project.unsupported.map((item) => `${item.ext} (${item.count})`).join(', ');
    say(`  ${C.yellow}skipped ${total} file${total === 1 ? '' : 's'} in unsupported formats: ${list}${C.reset}`);
    say(`  ${C.dim}crucible cannot mutate these, so they are outside this report.${C.reset}`);
  }
  if (project.workspaces?.length) {
    say(`  ${C.dim}monorepo: ${project.workspaces.length} package${project.workspaces.length === 1 ? '' : 's'} detected — run scan per package for full coverage.${C.reset}`);
  }
  say('');

  const boundary = deduped.filter((f) => f.kind === 'boundary');
  const boundaryKeys = new Set(boundary.map((f) => `${f.file}:${f.line}`));

  // Group: certain first, because that is what we can defend.
  const byConfidence = (c) => deduped.filter((f) => f.confidence === c && !boundaryKeys.has(`${f.file}:${f.line}`));
  const certain = byConfidence(CONFIDENCE.CERTAIN);
  const likely = byConfidence(CONFIDENCE.LIKELY);
  const suspect = byConfidence(CONFIDENCE.SUSPECT);

  const render = (label, color, items, limit = 8, showFix = false) => {
    if (items.length === 0) return;
    say(`${color}${C.bold}${label}${C.reset} ${C.dim}(${items.length})${C.reset}`);
    for (const f of items.slice(0, limit)) {
      say(`  ${color}${f.file}:${f.line}${C.reset} ${C.dim}${f.id}${C.reset}`);
      say(`    ${f.snippet}`);
      say(`    ${C.dim}${f.why}${C.reset}`);
      if (showFix && f.fix) say(`    ${C.cyan}→ ${f.fix}${C.reset}`);
    }
    if (items.length > limit) say(`  ${C.dim}... ${items.length - limit} more${C.reset}`);
    say('');
  };


  render('Untested edges', C.magenta, boundary, 6, true);
  render('Tests that cannot fail', C.red, certain);
  render('Tests that do not check values', C.yellow, likely);
  render('Worth a look (may be intentional)', C.dim, suspect, 4);

  if (uncovered.length > 0) {
    say(`${C.yellow}${C.bold}No test covers these files${C.reset} ${C.dim}(${uncovered.length})${C.reset}`);
    for (const f of uncovered.slice(0, 8)) say(`  ${f}`);
    if (uncovered.length > 8) say(`  ${C.dim}... ${uncovered.length - 8} more${C.reset}`);
    say(`${C.dim}This is not the same as a fake test: nothing runs these at all.${C.reset}`);
    say('');
  }

  const skippedFiles = mutationFiles.filter((f) => f.skipped > 0);
  if (skippedFiles.length > 0) {
    say(`${C.yellow}${C.bold}Could not be audited${C.reset} ${C.dim}(${skippedFiles.length})${C.reset}`);
    for (const f of skippedFiles.slice(0, 6)) {
      say(`  ${f.relFile} ${C.dim}— ${f.skippedReason ?? 'mutations could not be applied'}${C.reset}`);
    }
    if (skippedFiles.length > 6) say(`  ${C.dim}... ${skippedFiles.length - 6} more${C.reset}`);
    say('');
  }

  if (envNoise) {
    say(`${C.yellow}${C.bold}Audit ran with environment noise${C.reset}`);
    say(`  ${envNoise.what}. ${envNoise.fix}`);
    say(`${C.dim}  Tests that failed to start could not catch a mutation, so the score may be low for that reason.${C.reset}`);
    say('');
  }

  if (project.truncated) {
    say(`${C.yellow}The directory walk stopped at the depth limit; some files were not seen.${C.reset}`);
    say('');
  }

  // Boundary findings are graded `likely` too; subtract them so the same finding
  // is not printed twice in two different columns.
  const weakTests = Math.max(0, summary.likelyFake - boundary.length);
  say(`${C.bold}${summary.fakeTests} tests cannot fail${C.reset}`
    + `, ${boundary.length} untested edge${boundary.length === 1 ? '' : 's'}`
    + (weakTests ? `, ${weakTests} do not check values` : '')
    + (summary.worthChecking ? `, ${summary.worthChecking} to review` : ''));

  if (scorePercent !== null) {
    const cachedCount = mutationFiles.filter((f) => f.cached).length;
    say(`${C.dim}mutation score ${scorePercent}% across ${scoredFiles.length} file${scoredFiles.length === 1 ? '' : 's'}`
      + ` (${killedTotal} killed, ${survivedTotal} survived)`
      + (cachedCount > 0 ? ` · ${cachedCount} from cache` : '') + `${C.reset}`);
  }
  if (scoreGate) {
    say(`${gateFailed ? C.red : C.dim}${scoreGate}${C.reset}`);
  }

  if (summary.fakeTests + summary.likelyFake > 0) {
    say('');
    say(`Run ${C.cyan}crucible fix ${target}${C.reset} to pin the values these tests skip.`);
  }
}

/**
 * Write regression tests that pin real values, reusing inputs the existing tests
 * already trust. Verified afterwards: we report the score change, not a claim.
 */
async function cmdFix() {
  say(`${C.bold}crucible${C.reset} ${C.dim}fixing ${target}${C.reset}`);

  const project = await discover(target);
  if (!project.runner) {
    console.error(`${C.red}no test runner detected (looked for package.json test script, vitest, jest, ava, mocha, pytest, go, cargo, swift)${C.reset}`);
    const lines = workspaceLines(project);
    if (lines.length > 0) {
      console.error('');
      for (const line of lines) console.error(`${C.dim}${line}${C.reset}`);
    }
    console.error(reportHint('That means crucible found the project but not how it runs its tests.'));
    process.exitCode = 2;
    return;
  }

  // The same honesty scan applies here: "suite is red" is the wrong advice when
  // nothing was ever installed, and sending the user looking for a broken test
  // costs more than one extra check.
  if (project.runner.installed === false) {
    const pm = project.packageManager ?? 'npm';
    const install = pm === 'bun' ? 'bun install' : `${pm} install`;
    console.error(`${C.red}dependencies are not installed. Run \`${install}\` in ${project.root}, then try again.${C.reset}`);
    process.exitCode = 2;
    return;
  }

  const base = await baseline({ root: project.root, command: project.runner.command });
  if (!base.green) {
    console.error(`${C.red}${base.missing ? (base.hint ?? 'the test runner could not be started') : 'suite is red before we start; refusing to change anything'}${C.reset}`);
    process.exitCode = 2;
    return;
  }

  const probeStyle = ['vitest', 'jest'].includes(project.runner.name) ? project.runner.name : 'node';
  const covered = [...project.covers.entries()]
    .filter(([, tests]) => tests.length > 0)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const written = [];

  // Every file `fix` might touch, snapshotted before the first write. If the suite
  // goes red we restore these instead of leaving generated files behind for the
  // user to clean up. `null` means the file did not exist and must be removed.
  const snapshots = new Map();
  const rememberTarget = async (path) => {
    if (snapshots.has(path)) return;
    try {
      snapshots.set(path, await readFile(path, 'utf8'));
    } catch {
      snapshots.set(path, null);
    }
  };

  for (const [sourceFile, testFiles] of covered.slice(0, maxFiles)) {
    const rel = relPosix(project.root, sourceFile);
    const planned = placement({ sourceFile, testFiles, root: project.root });
    await rememberTarget(planned.fixPath);

    // 1. Boundaries first. This is the fix that kills real off-by-one bugs.
    const boundary = await fixBoundaries({
      root: project.root,
      sourceFile,
      testFiles,
      runner: project.runner.command,
      runnerName: probeStyle,
      force,
    });

    if (boundary.written) {
      written.push({ fixPath: boundary.written, kind: 'boundary' });
      say(`  ${C.green}wrote${C.reset} ${relPosix(project.root, boundary.written)}`
        + ` ${C.dim}(${boundary.cases} boundary comparison${boundary.cases === 1 ? '' : 's'} pinned)${C.reset}`);
      continue;
    }

    if (boundary.manual?.length) {
      say(`  ${C.cyan}manual${C.reset} ${rel} ${C.dim}(${boundary.reason})${C.reset}`);

      // Try the object-argument path for each manual case: some of them are
      // fixable by reusing the argument shape the project's tests already build.
      const sourceText = await readFile(sourceFile, 'utf8');
      const mapped = mapComparisonsToFunctions(sourceText);
      let objectFixed = 0;

      for (const { fn, comparison } of mapped) {
        // Each function writes its own file (placement's `variant`), so snapshot
        // that exact path for the rollback as well as the shared one above.
        await rememberTarget(placement({
          sourceFile, testFiles, root: project.root, variant: fn,
        }).fixPath);
        const result = await fixObjectBoundary({
          root: project.root,
          sourceFile,
          testFiles,
          fn,
          comparison,
          source: sourceText,
          runner: probeStyle,
          force,
        });

        if (result.written) {
          objectFixed += 1;
          written.push({ fixPath: result.written, kind: 'object-boundary' });
          say(`  ${C.green}wrote${C.reset} ${relPosix(project.root, result.written)}`
            + ` ${C.dim}(${fn}: ${comparison.left} ${comparison.op} ${comparison.right})${C.reset}`);
        }
      }

      if (objectFixed > 0) continue;
    }

    // 2. Otherwise pin exact values for the calls the tests already make.
    const source = await readFile(sourceFile, 'utf8');
    const names = exportedNames(source);
    if (names.length === 0) continue;

    let testSource = '';
    for (const tf of testFiles) {
      try { testSource += await readFile(tf, 'utf8'); } catch { /* ignore */ }
    }
    if (hasValuePinningAssertions(testSource)) continue;

    const sites = [];
    for (const tf of testFiles) {
      const text = await readFile(tf, 'utf8');
      sites.push(...harvestCallSites(text, names));
    }
    if (sites.length === 0) continue;

    const { fixPath, importPath, dir, probeName } = planned;

    // Plain JavaScript can be read with `node probe.mjs`, so the whole suite is not
    // run just to observe a return value. TypeScript needs the project's runner.
    const plainJs = ['.js', '.mjs', '.cjs'].includes(extname(sourceFile).toLowerCase());
    const probePath = plainJs ? join(dir, '__crucible_values.probe.mjs') : join(dir, probeName);
    registerTempFile(probePath);

    try {
      let probed = null;
      if (plainJs) {
        await writeFile(probePath, buildValueProbe({ importPath, sites }), 'utf8');
        const probeRun = await run(`node ${JSON.stringify(probePath)}`, project.root, 60_000);
        probed = parseProbeOutput(probeRun.stdout + probeRun.stderr);
      } else {
        await writeFile(probePath, buildProbe({ importPath, sites, runner: probeStyle }), 'utf8');
        const probeRun = await run(project.runner.command, project.root, 120_000);
        probed = parseProbeOutput(probeRun.stdout + probeRun.stderr);
      }

      if (!probed || probed.length === 0) {
        say(`  ${C.yellow}skip${C.reset} ${rel} ${C.dim}(could not read values with a probe)${C.reset}`);
        continue;
      }

      const body = buildFixTest({
        importPath,
        probed,
        sourceName: basename(sourceFile).replace(/\.[^.]+$/, ''),
        runner: probeStyle,
      });

      if (!/\b(expect|assert)\.?\w*\(/.test(body)) {
        say(`  ${C.yellow}skip${C.reset} ${rel} ${C.dim}(no pinnable values)${C.reset}`);
        continue;
      }

      const gate = await mayWrite(fixPath, { force });
      if (!gate.write) {
        say(`  ${C.yellow}skip${C.reset} ${relPosix(project.root, fixPath)} ${C.dim}(${gate.reason})${C.reset}`);
        continue;
      }
      await writeFile(fixPath, stamp(body, 'js'), 'utf8');
      written.push({ fixPath, kind: 'values' });
      say(`  ${C.green}wrote${C.reset} ${relPosix(project.root, fixPath)}`
        + ` ${C.dim}(${probed.length} calls pinned)${C.reset}`);
    } finally {
      await rm(probePath, { force: true });
      unregisterTempFile(probePath);
    }
  }

  if (written.length === 0) {
    say(`  ${C.dim}nothing to fix${C.reset}`);
    return;
  }

  const after = await baseline({ root: project.root, command: project.runner.command });
  say('');
  if (after.green) {
    say(`${C.green}${C.bold}${written.length} file(s) written, suite still green.${C.reset}`);
    say(`Run ${C.cyan}crucible verify ${target}${C.reset} to see the new mutation score.`);
  } else {
    // Never leave the tree red. Restore every target to its pre-run state: files
    // that existed get their content back, files we created are removed.
    let restored = 0;
    for (const [path, content] of snapshots) {
      try {
        if (content === null) await rm(path, { force: true });
        else await writeFile(path, content, 'utf8');
        restored += 1;
      } catch { /* best effort; the message below still tells the truth */ }
    }
    say(`${C.red}the suite went red after writing the new tests.${C.reset}`);
    say(`${C.dim}Rolled back ${restored} generated target${restored === 1 ? '' : 's'}; your tree is unchanged.${C.reset}`);
    process.exitCode = 1;
  }
}

async function cmdVerify() {
  await cmdScan();
}

/** `~/.config/...` reads better than `/Users/you/.config/...` in a one-line report. */
function displayPath(p) {
  const posix = toPosix(p);
  const home = toPosix(homedir());
  return posix === home || posix.startsWith(`${home}/`) ? `~${posix.slice(home.length)}` : posix;
}

/**
 * Put the agent skill where the agent looks for it.
 *
 * Read this as an update, not a one-time install: the interesting case is a user
 * who ran it two releases ago and whose SKILL.md now describes flags that changed.
 */
async function cmdInstall() {
  const dirArg = argv.find((a) => a.startsWith('--dir='));
  const explicit = dirArg ? dirArg.slice('--dir='.length) : positional[1];
  const targets = explicit
    ? [{ agent: 'custom path', target: explicit }]
    : defaultSkillTargets();

  say(`  ${C.bold}agent skill${C.reset}`);

  let problems = 0;
  for (const { agent, target } of targets) {
    const result = await installSkill(target, { force });
    const where = `${C.dim}${agent}${C.reset}  ${displayPath(target)}`;

    switch (result.status) {
      case 'installed':
        say(`    ${C.green}installed${C.reset}   ${where}`);
        break;
      case 'replaced':
        say(`    ${C.green}updated${C.reset}     ${where}`);
        break;
      case 'current':
        say(`    ${C.dim}up to date${C.reset}  ${where}`);
        break;
      case 'symlink':
        say(`    ${C.dim}left alone${C.reset}  ${where} ${C.dim}(symlink to ${result.link})${C.reset}`);
        break;
      case 'conflict':
        problems += 1;
        say(`    ${C.yellow}differs${C.reset}     ${where}`);
        say(`      ${C.dim}${result.changed.join(', ')} changed since it was installed.${C.reset}`);
        say(`      ${C.dim}Re-run with --force to replace it.${C.reset}`);
        break;
      case 'not-a-directory':
        problems += 1;
        say(`    ${C.red}not a directory${C.reset}  ${where}`);
        break;
      case 'no-source':
        say(`    ${C.red}this install has no skill${C.reset}`);
        say(`      ${C.dim}The package was published without skills/crucible. Reinstall from npm,${C.reset}`);
        say(`      ${C.dim}or from a checkout: ln -s "$PWD/skills/crucible" ~/.config/opencode/skills/crucible${C.reset}`);
        process.exitCode = 2;
        return;
      default:
        problems += 1;
        say(`    ${C.red}${result.status}${C.reset}  ${where}`);
    }
  }

  if (problems > 0) {
    process.exitCode = 1;
    return;
  }

  say('');
  say(`${C.dim}Restart your agent so it reads the skill, then ask: "are these tests real?"${C.reset}`);
}

const commands = { check: cmdCheck, scan: cmdScan, fix: cmdFix, verify: cmdVerify, install: cmdInstall };

const USAGE = `usage:
  crucible check  [path]  fast: read the tests, report those that cannot fail
  crucible scan   [path]  slow: mutate the source, find untested boundaries
  crucible fix    [path]  write the boundary tests that were missing
  crucible verify [path]  re-run the audit after a fix
  crucible install        copy the agent skill into OpenCode and Claude Code

  [path] defaults to the current directory; a single file audits just that file.
  install finds ~/.config/opencode and ~/.claude by itself and leaves a symlink alone.

options:
  --json            machine-readable output, with a next step per finding
  --limit=N         scan: audit at most N source files (default 12)
  --jobs=N          scan: parallel sandbox workers (default min(4, cpus); 1 = in place)
  --no-cache        scan: ignore the incremental results cache
  --fail-under=N    scan: exit 1 when the mutation score is below N percent
  --verbose         scan: print each mutation as it runs
  --no-mutation     scan: static checks only, no test runs
  --profile=NAME    scan: logic (default, skips tuning constants) or strict
  --allow-env-noise scan: audit even when the runner exits on an environment error
  --force           fix: overwrite a generated test file edited by hand
                    install: replace a skill copy that differs from this one
  --dir=PATH        install: copy the skill here instead of the detected agents
  --version, -v     print the version and platform

examples:
  crucible check                 # is anything obviously broken?
  crucible check src/cart.js     # just the tests that cover one file
  crucible scan --limit=3        # deeper look at three files
  crucible scan --fail-under=80  # CI gate on the mutation score
  crucible fix && crucible verify
  crucible install               # let the agent notice crucible on its own

exit codes:
  0  nothing certainly wrong
  1  something cannot fail (check, scan), the mutation score is below
     --fail-under, the suite went red after a fix, or a skill copy on disk is not
     the one this version ships
  2  could not run at all`;

// Unknown options must fail loudly. Silently ignoring `--verbos` or `--limt=3`
// meant the user believed a flag applied when it did not.
const BOOLEAN_FLAGS = new Set([
  '--json', '--verbose', '--no-mutation', '--force', '--allow-env-noise',
  '--no-cache', '--version', '-v', '--help', '-h',
]);
const VALUE_FLAG_PREFIXES = ['--limit=', '--profile=', '--dir=', '--jobs=', '--fail-under='];
for (const arg of argv) {
  if (!arg.startsWith('-')) continue;
  if (BOOLEAN_FLAGS.has(arg)) continue;
  if (VALUE_FLAG_PREFIXES.some((prefix) => arg.startsWith(prefix))) continue;
  console.error(`unknown option: ${arg}\n\n${USAGE}`);
  process.exit(1);
}

if (!command || command === 'help' || flags.has('--help') || flags.has('-h')) {
  console.log(USAGE);
  process.exit(0);
}

if (!commands[command]) {
  console.error(`unknown command: ${command}\n\n${USAGE}`);
  process.exit(1);
}

/**
 * A crash is our bug, not the user's.
 *
 * Without this, an unexpected throw prints a stack trace and nothing else — the
 * user has no idea whether they did something wrong, and no easy way to tell us.
 * The exit code stays non-zero so scripts still see a failure.
 */
process.on('uncaughtException', (error) => {
  console.error(`${C.red}crucible crashed.${C.reset} That is a bug here, not in your project.`);
  console.error('');
  console.error(`${C.dim}${error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n') : String(error)}${C.reset}`);
  console.error('');
  console.error(reportHint('Please include the stack above and the command you ran.'));
  process.exit(2);
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  console.error(`${C.red}crucible crashed.${C.reset} That is a bug here, not in your project.`);
  console.error('');
  console.error(`${C.dim}${error.stack ? error.stack.split('\n').slice(0, 6).join('\n') : String(reason)}${C.reset}`);
  console.error('');
  console.error(reportHint('Please include the stack above and the command you ran.'));
  process.exit(2);
});

await commands[command]();
