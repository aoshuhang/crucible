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
 */

import { readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { discover } from '../src/discover.js';
import { baseline, auditFile, run } from '../src/judge.js';
import { scanTestSource, assertionCount } from '../src/detect.js';
import { gradeFinding, gradeSurvivor, hasValuePinningAssertions, headline, CONFIDENCE } from '../src/confidence.js';
import { rankSurvivors, isBoundaryMutation } from '../src/boundary.js';
import { exportedNames, harvestCallSites, buildProbe, parseProbeOutput,
  buildFixTest, placement } from '../src/fix.js';
import { fixBoundaries } from '../src/fix-boundary.js';
import { fixObjectBoundary } from '../src/fix-object.js';
import { nextStepFor, planFor } from '../src/next.js';
import { mapComparisonsToFunctions } from '../src/fix-boundary.js';

const C = {
  reset: '\u001b[0m', dim: '\u001b[2m', bold: '\u001b[1m',
  red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m',
  cyan: '\u001b[36m', magenta: '\u001b[35m',
};

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('-')));
const positional = argv.filter((a) => !a.startsWith('-'));
const command = positional[0] ?? 'scan';
const target = positional[1] ?? process.cwd();

const asJson = flags.has('--json');
const verbose = flags.has('--verbose');
const noMutation = flags.has('--no-mutation');
const limitArg = argv.find((a) => a.startsWith('--limit='));
const maxFiles = limitArg ? Number(limitArg.split('=')[1]) : 12;

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

    const rel = testFile.replace(project.root + '/', '');
    for (const f of scanTestSource(text, rel)) {
      findings.push({ ...f, confidence: gradeFinding(f) });
    }
  }

  return findings;
}

/** Mutation pass over covered source files. */
async function mutationPass(project, { onProgress } = {}) {
  const covered = [...project.covers.entries()].filter(([, tests]) => tests.length > 0);
  const files = [];

  for (const [sourceFile, testFiles] of covered.slice(0, maxFiles)) {
    const result = await auditFile({
      root: project.root,
      file: sourceFile,
      command: project.runner.command,
      profile,
      testFiles,
      onProgress,
    });

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
      relFile: sourceFile.replace(project.root + '/', ''),
      testFiles: testFiles.map((t) => t.replace(project.root + '/', '')),
      grade,
      survivorFindings: ranked.filter((s) => s.boundary || s.threshold).map((s) => ({
        id: 'untested-boundary',
        file: sourceFile.replace(project.root + '/', ''),
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

async function cmdScan() {
  say(`${C.bold}crucible${C.reset} ${C.dim}${target}${C.reset}`);

  const project = await discover(target);
  if (!project.runner) {
    const msg = 'no test runner detected (looked for package.json test script, vitest, jest, ava, mocha, pytest, go, cargo, swift)';
    if (asJson) return console.log(JSON.stringify({ error: msg }, null, 2));
    console.error(`${C.red}${msg}${C.reset}`);
    process.exitCode = 2;
    return;
  }

  // Files nothing references. Reporting zero findings for a project where nothing
  // is covered would read as "healthy", which is the opposite of the truth.
  const uncovered = [...project.covers.entries()]
    .filter(([, tests]) => tests.length === 0)
    .map(([src]) => src.replace(project.root + '/', ''));

  // Static findings need no execution, so report them even if the suite is red.
  const staticFindings = await staticPass(project);

  let mutationFiles = [];
  let base = null;
  let suiteError = null;

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

  if (asJson) {
    // Each finding carries the next action, and the run carries an ordered plan.
    // An agent should not have to interpret the report, only execute it.
    const enriched = allFindings.map((f) => ({ ...f, next: nextStepFor(f, { root: project.root }) }));

    return console.log(JSON.stringify({
      root: project.root,
      runner: project.runner.name,
      baselineMs: base?.ms ?? null,
      suiteError,
      summary,
      uncovered,
      truncated: project.truncated ?? false,
      plan: planFor({
        findings: enriched,
        summary,
        suiteGreen: base ? base.green : false,
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
      })),
    }, null, 2));
  }

  const stateLabel = !base
    ? ''
    : base.green
      ? ` ${C.dim}(green in ${base.ms}ms)${C.reset}`
      : base.missing
        ? ` ${C.yellow}(runner not found)${C.reset}`
        : ` ${C.red}(suite is red)${C.reset}`;

  say(`  runner ${C.cyan}${project.runner.name}${C.reset}${stateLabel}`);
  say(`  ${project.sourceFiles.length} source, ${project.testFiles.length} test files`);
  if (suiteError) say(`  ${C.yellow}${suiteError}${C.reset}`);
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

  if (project.truncated) {
    say(`${C.yellow}The directory walk stopped at the depth limit; some files were not seen.${C.reset}`);
    say('');
  }

  say(`${C.bold}${summary.fakeTests} tests cannot fail${C.reset}`
    + `, ${boundary.length} untested edge${boundary.length === 1 ? '' : 's'}`
    + `, ${summary.likelyFake} do not check values`
    + (summary.worthChecking ? `, ${summary.worthChecking} to review` : ''));

  if (mutationFiles.length > 0) {
    const scored = mutationFiles.filter((f) => f.score !== null);
    if (scored.length) {
      const avg = scored.reduce((n, f) => n + f.score, 0) / scored.length;
      say(`${C.dim}mutation score ${Math.round(avg * 100)}% across ${scored.length} files${C.reset}`);
    }
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
    console.error(`${C.red}no test runner detected${C.reset}`);
    process.exitCode = 2;
    return;
  }

  const base = await baseline({ root: project.root, command: project.runner.command });
  if (!base.green) {
    console.error(`${C.red}suite is red before we start; refusing to change anything${C.reset}`);
    process.exitCode = 2;
    return;
  }

  const probeStyle = ['vitest', 'jest'].includes(project.runner.name) ? project.runner.name : 'node';
  const covered = [...project.covers.entries()].filter(([, tests]) => tests.length > 0);
  const written = [];

  for (const [sourceFile, testFiles] of covered.slice(0, maxFiles)) {
    const rel = sourceFile.replace(project.root + '/', '');

    // 1. Boundaries first. This is the fix that kills real off-by-one bugs.
    const boundary = await fixBoundaries({
      root: project.root,
      sourceFile,
      testFiles,
      runner: project.runner.command,
      runnerName: probeStyle,
    });

    if (boundary.written) {
      written.push({ fixPath: boundary.written, kind: 'boundary' });
      say(`  ${C.green}wrote${C.reset} ${boundary.written.replace(project.root + '/', '')}`
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
        const result = await fixObjectBoundary({
          root: project.root,
          sourceFile,
          testFiles,
          fn,
          comparison,
          source: sourceText,
          runner: probeStyle,
        });

        if (result.written) {
          objectFixed += 1;
          written.push({ fixPath: result.written, kind: 'object-boundary' });
          say(`  ${C.green}wrote${C.reset} ${result.written.replace(project.root + '/', '')}`
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

    const { fixPath, importPath, dir, probeName } = placement({ sourceFile, testFiles, root: project.root });
    const probePath = join(dir, probeName);
    const fs = await import('node:fs/promises');

    try {
      await fs.writeFile(probePath, buildProbe({ importPath, sites, runner: probeStyle }), 'utf8');
      const probeRun = await run(project.runner.command, project.root, 120_000);
      const probed = parseProbeOutput(probeRun.stdout + probeRun.stderr);

      if (!probed || probed.length === 0) {
        say(`  ${C.yellow}skip${C.reset} ${rel} ${C.dim}(${boundary.reason ?? 'could not read values'})${C.reset}`);
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

      await fs.writeFile(fixPath, body, 'utf8');
      written.push({ fixPath, kind: 'values' });
      say(`  ${C.green}wrote${C.reset} ${fixPath.replace(project.root + '/', '')}`
        + ` ${C.dim}(${probed.length} calls pinned)${C.reset}`);
    } finally {
      await fs.rm(probePath, { force: true });
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
    say(`${C.red}the suite went red after writing the new tests.${C.reset}`);
    say(`${C.dim}Review the generated files, or delete them and re-run.${C.reset}`);
    process.exitCode = 1;
  }
}

async function cmdVerify() {
  await cmdScan();
}

const commands = { scan: cmdScan, fix: cmdFix, verify: cmdVerify };

if (!commands[command]) {
  console.error(`unknown command: ${command}

usage:
  crucible scan   [dir]   report tests that cannot fail
  crucible fix    [dir]   write regression tests that pin real values
  crucible verify [dir]   re-run after a fix

options:
  --json           machine-readable output
  --verbose        show each mutation as it runs
  --no-mutation    static checks only (fast, no test runs)
  --limit=N        audit at most N source files (default 12)
  --profile=NAME   logic (default, skips tuning constants) or strict`);
  process.exit(1);
}

await commands[command]();
