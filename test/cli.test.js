import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/crucible.js', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/project/', import.meta.url));

/** Run the CLI and capture the exit code instead of throwing on non-zero. */
async function cli(args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], { timeout: 180_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : -1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
    };
  }
}

async function fixtureCopy(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-cli-'));
  await cp(FIXTURE, dir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('scan exits 1 when a test certainly cannot fail', async (t) => {
  const dir = await fixtureCopy(t);
  const result = await cli(['scan', dir, '--jobs=1', '--no-cache']);

  // The README gates CI on this exit code. It used to always be 0.
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /cannot fail/);
});

test('check exits 1 when a test certainly cannot fail', async (t) => {
  const dir = await fixtureCopy(t);
  const result = await cli(['check', dir]);
  assert.equal(result.code, 1, result.stderr);
});

test('--limit rejects a non-integer instead of silently auditing nothing', async (t) => {
  const dir = await fixtureCopy(t);
  const result = await cli(['scan', dir, '--limit=abc']);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /--limit expects a positive integer/);
});

test('--limit=0 is an error too', async (t) => {
  const dir = await fixtureCopy(t);
  const result = await cli(['scan', dir, '--limit=0']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /positive integer/);
});

test('an unknown option is an error, not silently ignored', async (t) => {
  const dir = await fixtureCopy(t);
  const result = await cli(['scan', dir, '--verbos']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown option: --verbos/);
});

test('--jobs and --fail-under validate their numbers', async (t) => {
  const dir = await fixtureCopy(t);
  assert.match((await cli(['scan', dir, '--jobs=x'])).stderr, /--jobs expects/);
  assert.match((await cli(['scan', dir, '--fail-under=101'])).stderr, /between 0 and 100/);
});

test('JSON findings are the same deduplicated list the summary counts', async (t) => {
  const dir = await fixtureCopy(t);
  const result = await cli(['scan', dir, '--json', '--jobs=1', '--no-cache']);
  const report = JSON.parse(result.stdout);

  const counted = report.summary.fakeTests + report.summary.likelyFake + report.summary.worthChecking;
  assert.equal(report.findings.length, counted,
    'summary and findings must describe the same set');
  for (const finding of report.findings) {
    assert.ok(finding.next, `finding ${finding.id} must carry a next step`);
  }
});

test('a static-only run does not tell an agent the suite is red', async (t) => {
  const dir = await fixtureCopy(t);
  const result = await cli(['scan', dir, '--json', '--no-mutation']);
  const report = JSON.parse(result.stdout);

  const actions = report.plan.steps.map((step) => step.action);
  assert.ok(!actions.includes('fix the failing suite first'),
    'no tests were run, so there is no failing suite to fix');
  assert.ok(report.plan.doNotClaim.some((line) => /no tests were executed/.test(line)));
});

test('a single test file is a valid check target', async (t) => {
  const dir = await fixtureCopy(t);
  const result = await cli(['check', join(dir, 'tests/fake.test.js'), '--json']);
  const report = JSON.parse(result.stdout);

  assert.equal(report.target, 'tests/fake.test.js');
  assert.equal(report.testFiles, 1);
  assert.ok(report.summary.cannotFail >= 1);
});

test('a single source file is a valid scan target', async (t) => {
  const dir = await fixtureCopy(t);
  const result = await cli(['scan', join(dir, 'src/limits.js'), '--json', '--jobs=1', '--no-cache']);
  const report = JSON.parse(result.stdout);

  assert.equal(report.target, 'src/limits.js');
  assert.deepEqual(report.files.map((file) => file.file), ['src/limits.js']);
});

test('a default scan labels its mutation score as sampled', async (t) => {
  const dir = await fixtureCopy(t);
  const result = await cli(['scan', dir, '--json', '--jobs=1', '--no-cache']);
  const report = JSON.parse(result.stdout);

  assert.equal(report.scoreKind, 'sampled');
  assert.equal(report.sampling.complete, false);
  assert.equal(report.sampling.filesAudited, 1);
  assert.equal(report.sampling.filesNotAudited, 0);
  assert.ok(report.sampling.mutantsExecuted > 0);
});

test('--limit=all --mutations=all produces a complete score', async (t) => {
  const dir = await fixtureCopy(t);
  const result = await cli([
    'scan', dir, '--json', '--jobs=1', '--no-cache',
    '--limit=all', '--mutations=all', '--select=all',
  ]);
  const report = JSON.parse(result.stdout);

  assert.equal(report.scoreKind, 'complete');
  assert.equal(report.sampling.complete, true);
  assert.equal(report.sampling.mutantsExecuted, report.sampling.mutantsAvailable);
  assert.equal(report.limit, null);
});

test('--select rejects an unknown mode', async (t) => {
  const dir = await fixtureCopy(t);
  const result = await cli(['scan', dir, '--select=fastest']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown --select mode/);
});

test('a file with no mutation candidates does not consume --limit', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-empty-source-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'barrel', type: 'module', scripts: { test: 'node --test' },
  }), 'utf8');
  await mkdir(join(dir, 'lib'), { recursive: true });
  await writeFile(join(dir, 'index.js'), "export { value } from './lib/value.js';\n", 'utf8');
  await writeFile(join(dir, 'lib/value.js'),
    'export function value(n) {\n  return n > 2 ? n : 0;\n}\n', 'utf8');
  await writeFile(join(dir, 't.test.js'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from './index.js';\ntest('value', () => { assert.equal(value(3), 3); });\n", 'utf8');

  const result = await cli(['scan', dir, '--json', '--jobs=1', '--no-cache', '--limit=1', '--mutations=2']);
  const report = JSON.parse(result.stdout);

  assert.deepEqual(report.files.map((file) => file.file), ['lib/value.js'],
    'the empty barrel must be skipped and the real file audited');
  assert.equal(report.sampling.filesWithoutMutants, 1);
  assert.ok(report.mutationScore !== null, 'the run must still produce a score');
});

test('fix reports why a CommonJS project cannot be auto-fixed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-cjs-fix-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'cjs', scripts: { test: 'node --test' },
  }), 'utf8');
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src/value.js'),
    'module.exports = function value(n) { return n > 2 ? n : 0; };\n', 'utf8');
  await writeFile(join(dir, 't.test.js'),
    "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst value = require('./src/value.js');\ntest('value', () => { assert.equal(value(3), 3); });\n", 'utf8');

  const result = await cli(['fix', dir, '--json', '--limit=1']);
  const report = JSON.parse(result.stdout);

  assert.deepEqual(report.written, []);
  assert.equal(report.next.kind, 'review',
    'no repair means the agent must review, not re-run scan as if something was fixed');
  assert.ok(report.skipped.some((item) => /CommonJS/.test(item.reason)),
    'the output must name the actual limitation');
});

test('a second scan reuses the cached result', async (t) => {
  const dir = await fixtureCopy(t);

  const first = JSON.parse((await cli(['scan', dir, '--json', '--jobs=1'])).stdout);
  const second = JSON.parse((await cli(['scan', dir, '--json', '--jobs=1'])).stdout);

  assert.equal(first.files[0].cached, false);
  assert.equal(second.files[0].cached, true, 'unchanged inputs must hit the cache');
  assert.equal(first.mutationScore, second.mutationScore);
});
