import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { cp, mkdtemp, rm } from 'node:fs/promises';
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

test('a second scan reuses the cached result', async (t) => {
  const dir = await fixtureCopy(t);

  const first = JSON.parse((await cli(['scan', dir, '--json', '--jobs=1'])).stdout);
  const second = JSON.parse((await cli(['scan', dir, '--json', '--jobs=1'])).stdout);

  assert.equal(first.files[0].cached, false);
  assert.equal(second.files[0].cached, true, 'unchanged inputs must hit the cache');
  assert.equal(first.mutationScore, second.mutationScore);
});
