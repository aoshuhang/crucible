import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  trackInFlight, clearInFlight, restoreInFlightSync,
  registerSandbox, cleanupSandboxesSync,
  registerTempFile, unregisterTempFile, cleanupTempFilesSync,
} from '../src/judge.js';

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/crucible.js', import.meta.url));

/**
 * A tool that rewrites source in place must restore it on every exit path, including
 * the signal path that Ctrl-C takes.
 */

test('in-flight content is restored synchronously', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-restore-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = join(dir, 'a.js');
  const original = 'export const a = 1;\n';
  await writeFile(file, original, 'utf8');

  await writeFile(file, 'export const a = 2;\n', 'utf8');
  trackInFlight(file, original);

  assert.equal(restoreInFlightSync(), 1);
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal(restoreInFlightSync(), 0, 'the registry is cleared after restoring');

  clearInFlight(file); // no-op, but must not throw
});

test('temporary probe files are removed synchronously and can be unregistered', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-probe-cleanup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const probe = join(dir, 'probe.test.js');
  await writeFile(probe, '// probe\n', 'utf8');
  registerTempFile(probe);

  assert.equal(cleanupTempFilesSync(), 1);
  await assert.rejects(access(probe));

  // A probe cleaned up by its own finally block must not linger in the registry.
  await writeFile(probe, '// probe\n', 'utf8');
  registerTempFile(probe);
  unregisterTempFile(probe);
  assert.equal(cleanupTempFilesSync(), 0);
  await access(probe); // the file is still there, as it should be
});

test('temporary sandboxes are removed synchronously', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-sandbox-cleanup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  registerSandbox(dir);
  assert.equal(cleanupSandboxesSync(), 1);
  await assert.rejects(access(dir), 'the sandbox directory must be gone');
});

test('fix rolls its writes back when the suite goes red', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-rollback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'rollback',
    private: true,
    type: 'module',
    scripts: { test: 'node --test tests/*.test.js' },
  }), 'utf8');
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'tests'), { recursive: true });

  // A non-deterministic function: the probe pins one value, the next run returns a
  // different one, so the generated test fails and the rollback path is exercised.
  // It needs an argument because a bare call gives the probe nothing to reuse.
  await writeFile(join(dir, 'src/rand.js'),
    'export function roll(seed) {\n  return Math.random() + seed;\n}\n', 'utf8');
  await writeFile(join(dir, 'tests/rand.test.js'),
    "import { test } from 'node:test';\nimport { roll } from '../src/rand.js';\n\ntest('roll runs', () => {\n  roll(1);\n});\n",
    'utf8');

  const fixPath = join(dir, 'tests/rand.exact.test.js');
  const before = await readFile(join(dir, 'src/rand.js'), 'utf8');

  let code = 0;
  try {
    await exec(process.execPath, [CLI, 'fix', dir], { timeout: 120_000 });
  } catch (error) {
    code = typeof error.code === 'number' ? error.code : -1;
  }

  assert.equal(code, 1, 'a red suite after writing is a failure');
  await assert.rejects(access(fixPath), 'the generated file must be rolled back');
  assert.equal(await readFile(join(dir, 'src/rand.js'), 'utf8'), before);
});
