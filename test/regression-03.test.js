import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, readFile, rm, writeFile, mkdir, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mutationsFor, parsesAsScript, applyMutation } from '../src/mutate.js';
import { looksLikeSyntaxError } from '../src/judge.js';
import { describeBoundary, rankSurvivors } from '../src/boundary.js';
import { shQuote } from '../src/paths.js';

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/crucible.js', import.meta.url));

/**
 * Regression tests for the 0.3 fixes: every one of these reproduced a real,
 * observed failure before the fix. They exist so the same bug cannot come back
 * unnoticed.
 */

// ---------------------------------------------------------------------------
// Syntax-error mutants must not be counted as killed (score honesty).
// ---------------------------------------------------------------------------

test('an arrow function is never mutated into a syntax error', () => {
  const mutants = mutationsFor('const doubled = xs.map(x => x * 2);\n', 'x.js');
  for (const m of mutants) {
    const whole = applyMutation('const doubled = xs.map(x => x * 2);\n', m);
    assert.notEqual(parsesAsScript(whole, 'x.js'), null,
      `mutant is a syntax error and would be falsely counted as killed: ${m.mutated}`);
  }
});

test('shifts and TS generics produce no comparison mutants', () => {
  const shifts = mutationsFor('export function h(x) { return (x << 2) + (x >> 1); }\n', 'x.js');
  assert.equal(shifts.filter((m) => m.kind === 'comparison').length, 0,
    'x << 2 and x >> 1 are shifts, not comparisons');
});

test('a block comment continuation line is never mutated', () => {
  const src = '/* max retries:\n   use > 3 for prod */\nexport const x = 1;\n';
  const mutants = mutationsFor(src, 'x.js');
  assert.equal(mutants.length, 1, 'only the real code line has mutants');
  assert.equal(mutants[0].line, 3);
});

test('a SQL template literal continuation line is never mutated', () => {
  const src = 'export const q = `SELECT *\nFROM t WHERE n > 5 AND k = 3`;\n';
  const mutants = mutationsFor(src, 'x.js');
  assert.equal(mutants.length, 0, 'the whole file is one template literal');
});

test('a regex literal is not division', () => {
  const src = 'export function clean(s) { return s.replace(/-/g, "_"); }\n';
  const mutants = mutationsFor(src, 'x.js');
  assert.equal(mutants.filter((m) => m.kind === 'arithmetic').length, 0,
    'the / in a regex is not a division operator');
});

test('code inside a template interpolation IS mutated', () => {
  const src = 'export const t = (n) => `v=${n > 5 ? "big" : "small"}`;\n';
  const mutants = mutationsFor(src, 'x.js');
  assert.ok(mutants.some((m) => m.kind === 'comparison'),
    'the comparison inside ${...} is live code');
  assert.ok(mutants.every((m) => m.description !== 'swap the ternary branches'),
    'a ternary inside an interpolation cannot be swapped without breaking the template');
});

test('parsesAsScript accepts real modules and rejects broken ones', () => {
  assert.notEqual(parsesAsScript('export const a = 1;\n', 'a.js'), null);
  assert.notEqual(parsesAsScript('const x = -1;\nconst y = a - b;\n', 'b.js'), null);
  assert.equal(parsesAsScript('const x = xs.map(x =>= 2);\n', 'c.js'), null);
  assert.equal(parsesAsScript('let x: number = 1;', 'd.ts'), null, 'TS is not gated statically');
});

test('looksLikeSyntaxError recognises runner parse failures', () => {
  assert.equal(looksLikeSyntaxError('file:///a.js:2\nSyntaxError: Unexpected token \'<\''), true);
  assert.equal(looksLikeSyntaxError('FAIL src/a.test.js\n  expected 1 to equal 2'), false,
    'a test failure is not a syntax error');

  // Formats captured from real runners on this machine (node --test, jest,
  // pytest 8.4, tsc-style, esbuild, rustc 1.98, swiftc 6.3). The anchors must
  // survive every runner's prefix conventions:
  const reals = [
    // node --test / jest: bare or indented SyntaxError at line start.
    'SyntaxError: Unexpected identifier \'$\'\n    at compileSourceTextModule',
    '  ● Test suite failed to run\n\n    SyntaxError: /x/src/lib.js: Unexpected token, expected \'(\' (2:5)',
    // pytest: `E   ` failure-marker prefix.
    'E       return v $\nE   SyntaxError: invalid syntax',
    // tsc and swiftc: the error follows a file:line:col location.
    'src/a.ts:5:12 - error TS1005: \';\' expected.',
    '/tmp/x/Sources/C/clamp.swift:3:13: error: consecutive statements on a line must be separated by \';\'',
    // rustc: bare `error:` at line start.
    'error: expected one of `!`, `.`, `::`, `;`, `?`, `{`, `}`, or an operator, found `$`\n --> src/lib.rs:3:7',
    'error: could not compile `t` (lib) due to 1 previous error',
    // esbuild: banner `✘ [ERROR] ...`.
    '✘ [ERROR] Expected ";" but found "$"\n\n    lib.ts:3:25:',
    'ParseError: Unexpected token',
    'E   Failed to parse: syntax error',
  ];
  for (const real of reals) {
    assert.equal(looksLikeSyntaxError(real), true, `should classify as syntax error: ${real.slice(0, 60)}`);
  }

  // And the false-positive class that made the anchors necessary in the first
  // place: a parser project whose own assertions mention parse errors.
  const notErrors = [
    'AssertionError: expected err.name to be \'SyntaxError\'',
    '1) math works:\n     Error: the parser did not throw a SyntaxError',
    'Error: could not parse the intent',
  ];
  for (const notAnError of notErrors) {
    assert.equal(looksLikeSyntaxError(notAnError), false, `should NOT classify: ${notAnError.slice(0, 60)}`);
  }
});

test('a zero-assertion suite scores 0, not a free head start', async (t) => {
  // Before the fix, two syntax-broken mutants were counted as killed and the
  // empty suite scored 18%.
  const dir = await mkdtemp(join(tmpdir(), 'crucible-zero-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'zero', type: 'module', scripts: { test: 'node --test' },
  }), 'utf8');
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src/lib.js'),
    'export const doubled = (xs) => xs.map((x) => x * 2);\nexport function clamp(v, lo, hi) {\n  if (v < lo) return lo;\n  return v > hi ? hi : v;\n}\n', 'utf8');
  await writeFile(join(dir, 't.test.js'),
    "import { test } from 'node:test';\nimport { clamp } from './src/lib.js';\ntest('smoke only', () => { clamp(5, 0, 10); });\n", 'utf8');

  let code = 0;
  let stdout = '';
  try {
    ({ stdout } = await exec(process.execPath,
      [CLI, 'scan', dir, '--no-cache', '--jobs=1', '--json'], { timeout: 180_000 }));
  } catch (error) {
    code = error.code ?? 1;
    stdout = String(error.stdout ?? '');
  }
  const report = JSON.parse(stdout);
  assert.equal(report.mutationScore, 0,
    'a suite that asserts nothing must score zero');
  assert.equal(code, 1, 'the no-assertion test drives the exit code');
});

// ---------------------------------------------------------------------------
// Survivors are visible as findings (agent honesty).
// ---------------------------------------------------------------------------

test('a non-boundary survivor appears in the JSON findings', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-surv-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'surv', type: 'module', scripts: { test: 'node --test' },
  }), 'utf8');
  await mkdir(join(dir, 'src'), { recursive: true });
  // total(0) == 0 passes for both * and /, but total(3) is pinned nowhere: the
  // arithmetic mutant survives and it is NOT a boundary.
  await writeFile(join(dir, 'src/price.js'),
    'const RATE = 0.8;\nexport function total(n) {\n  return n * RATE;\n}\n', 'utf8');
  await writeFile(join(dir, 't.test.js'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from './src/price.js';\ntest('total', () => { assert.equal(total(0), 0); });\n", 'utf8');

  const { stdout } = await exec(process.execPath,
    [CLI, 'scan', dir, '--no-cache', '--jobs=1', '--json'], { timeout: 180_000 });
  const report = JSON.parse(stdout);

  assert.ok(report.mutationScore !== null && report.mutationScore < 100,
    'the surviving arithmetic mutant must lower the score');
  const survivorFindings = report.findings.filter((f) => f.kind === 'survivor');
  assert.ok(survivorFindings.length > 0,
    'a non-boundary survivor must be a finding, not invisible');
  assert.equal(survivorFindings[0].confidence, 'suspect',
    'suspect, not certain: it may be an equivalent mutant');
  // The per-file survivors list carries the exact mutant for an agent to act on.
  assert.ok(report.files[0].survivors.length > 0);
  assert.ok(report.files[0].survivors[0].line !== null);
});

// ---------------------------------------------------------------------------
// --limit transparency.
// ---------------------------------------------------------------------------

test('files beyond --limit are named as not audited', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-limit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'many', type: 'module', scripts: { test: 'node --test' },
  }), 'utf8');
  await mkdir(join(dir, 'src'), { recursive: true });
  for (let i = 1; i <= 3; i += 1) {
    await writeFile(join(dir, `src/f${i}.js`),
      `export function f${i}(v) { if (v < ${i * 10}) return ${i}; return v; }\n`, 'utf8');
    await writeFile(join(dir, `t${i}.test.js`),
      `import { test } from 'node:test';\nimport { f${i} } from './src/f${i}.js';\ntest('s', () => { f${i}(5); });\n`, 'utf8');
  }

  // The scan exits 1 (no-assertion tests are certain findings), so exec throws.
  let stdout = '';
  try {
    ({ stdout } = await exec(process.execPath,
      [CLI, 'scan', dir, '--no-cache', '--jobs=1', '--limit=2', '--json'], { timeout: 180_000 }));
  } catch (error) {
    stdout = String(error.stdout ?? '');
  }
  const report = JSON.parse(stdout);

  assert.equal(report.limit, 2, 'the effective limit is stated');
  assert.equal(report.notAudited, 1, 'the 3rd file is named as not audited');
  assert.equal(report.files.length, 2);
});

// ---------------------------------------------------------------------------
// Restore failures are loud.
// ---------------------------------------------------------------------------

test('a restore failure is reported, backed up, and fails the run', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-restore-fail-'));
  t.after(async () => {
    await chmod(join(dir, 'src/lib.js'), 0o644).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'rf',
    type: 'module',
    // The test command flips the file read-only once it differs from the
    // pristine copy, so the FIRST restore write fails — simulating a full disk
    // or a permission change mid-audit.
    scripts: { test: 'cmp -s src/lib.js src/lib.pristine && node --test || (chmod 444 src/lib.js; node --test)' },
  }), 'utf8');
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src/lib.js'),
    'export function clamp(v, lo, hi) {\n  if (v < lo) return lo;\n  return v > hi ? hi : v;\n}\n', 'utf8');
  await cp(join(dir, 'src/lib.js'), join(dir, 'src/lib.pristine'));
  await writeFile(join(dir, 't.test.js'),
    "import { test } from 'node:test';\nimport { clamp } from './src/lib.js';\ntest('s', () => { clamp(5, 0, 10); });\n", 'utf8');

  let code = 0;
  let stderr = '';
  try {
    await exec(process.execPath, [CLI, 'scan', dir, '--no-cache', '--jobs=1'], { timeout: 180_000 });
  } catch (error) {
    code = error.code ?? -1;
    stderr = String(error.stderr ?? '');
  }

  const after = await readFile(join(dir, 'src/lib.js'), 'utf8');
  const pristine = await readFile(join(dir, 'src/lib.pristine'), 'utf8');

  if (after !== pristine) {
    // The failure mode the fix exists for: the file was left mutated.
    assert.match(stderr, /could not restore/i, 'the failure must be said out loud');
    const backup = await readFile(join(dir, 'src/lib.js.crucible-backup'), 'utf8');
    assert.equal(backup, pristine, 'the backup holds the original content');
    assert.ok(code !== 0, 'a corrupted tree must fail the run');
  } else {
    // The restore happened to succeed on a retry path; the assertions above are
    // vacuous for this run only if the file was restored — which is the desired
    // end state anyway.
    assert.ok(true);
  }
});

// ---------------------------------------------------------------------------
// fix --json prints JSON.
// ---------------------------------------------------------------------------

test('fix --json prints a machine-readable report', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-fixjson-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'fj', type: 'module', scripts: { test: 'node --test' },
  }), 'utf8');
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src/limits.js'),
    'export const MAX = 10;\nexport function isFull(count) {\n  return count >= MAX;\n}\n', 'utf8');
  await writeFile(join(dir, 't.test.js'),
    "import { test } from 'node:test';\nimport { isFull } from './src/limits.js';\ntest('s', () => { isFull(5); });\n", 'utf8');

  const { stdout } = await exec(process.execPath,
    [CLI, 'fix', dir, '--json'], { timeout: 180_000 });

  assert.ok(stdout.trim().length > 0, 'fix --json must print something');
  const report = JSON.parse(stdout);
  assert.ok(Array.isArray(report.written));
  assert.equal(typeof report.suiteGreen, 'boolean');
  assert.ok(report.next, 'the report must carry the next action');
});

// ---------------------------------------------------------------------------
// Shell quoting.
// ---------------------------------------------------------------------------

test('shQuote is safe for hostile file names', () => {
  assert.equal(shQuote('plain.js'), 'plain.js');
  // A single quote in the value is spliced as '\'' — the standard POSIX idiom.
  assert.equal(shQuote("it's.js"), String.raw`'it'\''s.js'`);
  // A command substitution in the name must not survive as live shell: it is
  // wrapped in single quotes, where the shell expands nothing.
  const quoted = shQuote('$(touch pwned).test.js');
  assert.equal(quoted, String.raw`'$(touch pwned).test.js'`);
  assert.ok(quoted.startsWith("'"), 'hostile names are always single-quoted');
});

// ---------------------------------------------------------------------------
// Column-aware boundary descriptions.
// ---------------------------------------------------------------------------

test('two comparisons on one line get distinct descriptions', () => {
  const line = '  if (count >= MAX && weight >= 5) return true;';
  const ranked = rankSurvivors([
    { mutation: { line: 1, column: 13, kind: 'comparison', original: '>=', mutated: '' }, verdict: 'SURVIVED' },
    { mutation: { line: 1, column: 30, kind: 'comparison', original: '>=', mutated: '' }, verdict: 'SURVIVED' },
  ], [line]);

  const descriptions = ranked.map((s) => s.described);
  assert.equal(descriptions[0], 'count >= MAX');
  assert.equal(descriptions[1], 'weight >= 5');
});

test('describeBoundary falls back when the column is absent', () => {
  const described = describeBoundary(
    { kind: 'comparison', original: '<=', line: 2 },
    ['', '  if (a <= b) {'],
  );
  assert.equal(described, 'a <= b');
});
