import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { environmentalNoise, baseline } from '../src/judge.js';
import { shQuote } from '../src/paths.js';

/**
 * A non-zero exit is not always a failing test.
 *
 * axios: 2554 tests pass, and vitest still exits 1 because Playwright's Firefox and
 * WebKit binaries are not installed. Reporting "suite is red" sends the user hunting
 * for a broken test that does not exist.
 *
 * The rule is strict: passing tests, no failing tests, and a known environment
 * error. If any of those is missing, the run is treated as genuinely red.
 */

const AXIOS_OUTPUT = `
 RUN  v5.1.0 /repo

⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯

Vitest caught 2 unhandled errors during the test run.

Error: browserType.launch: Executable doesn't exist at
/Users/x/Library/Caches/ms-playwright/firefox-1572/firefox/Nightly.app/Contents/MacOS/firefox
Please run the following command to download new browsers: npx playwright install

 Test Files  133 passed (189)
      Tests  2554 passed | 2 skipped (2556)
`;

test('a Go dependency download timeout is missing dependencies, not a red suite', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-go-network-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, 'go-fail.js');
  await writeFile(script, [
    "console.error('go: downloading example.com/dep v1.0.0');",
    "console.error('dial tcp 203.0.113.1:443: i/o timeout');",
    "console.error('FAIL example.com/x [setup failed]');",
    'process.exit(1);',
  ].join('\n'), 'utf8');

  const result = await baseline({
    root: dir,
    command: `${shQuote(process.execPath)} ${shQuote(script)}`,
    timeoutMs: 20_000,
  });

  assert.equal(result.missing, true);
  assert.match(result.hint, /GOPROXY|dependencies/i);
});

test('recognises a missing browser', () => {
  const noise = environmentalNoise(AXIOS_OUTPUT);
  assert.ok(noise);
  assert.match(noise.what, /browser/);
  assert.match(noise.fix, /playwright install/);
});

test('recognises an unreachable host', () => {
  const output = 'Error: connect ECONNREFUSED 127.0.0.1:5432\nUnhandled Error\nTests 10 passed';
  const noise = environmentalNoise(output);
  assert.ok(noise);
  assert.match(noise.what, /network|reach/i);
});

test('recognises a native addon that will not load', () => {
  const output = 'Error: Cannot find native module\nNODE_MODULE_VERSION 115\nUnhandled Error\nTests 3 passed';
  const noise = environmentalNoise(output);
  assert.ok(noise);
  assert.match(noise.what, /native/);
});

test('a genuine test failure is not environmental noise', () => {
  // One failing test is enough to make the whole run untrustworthy.
  const output = 'Unhandled Error\nTests 2553 passed | 1 failed (2554)';
  assert.equal(environmentalNoise(output), null);
});

test('a run with no passing tests is not environmental noise', () => {
  const output = 'Unhandled Error\nTests 0 passed';
  // Zero passed is suspicious; without evidence the tests ran, treat it as red.
  assert.equal(environmentalNoise(output), null);
});

test('a clean failure with no unhandled error is not environmental noise', () => {
  const output = 'Tests 100 passed\nTests 1 failed';
  assert.equal(environmentalNoise(output), null);
});

test('an unrecognised unhandled error is still reported, generically', () => {
  const output = 'Unhandled Error: something odd\nTests 50 passed';
  const noise = environmentalNoise(output);
  assert.ok(noise, 'the user still deserves to know the exit was not a test failure');
  assert.match(noise.what, /unhandled/);
});
