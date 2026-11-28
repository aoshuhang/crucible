import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discover } from '../src/discover.js';
import { baseline } from '../src/judge.js';

/**
 * Bugs found by running against real repositories in the wild:
 * golang/toml, pallets/itsdangerous, sindresorhus/escape-string-regexp.
 */

test('recognises Go test files', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-go-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'go.mod'), 'module example.com/x\n');
  await writeFile(join(dir, 'decode.go'), 'package x\nfunc Decode() {}\n');
  await writeFile(join(dir, 'decode_test.go'), 'package x\nfunc TestDecode() {}\n');

  const p = await discover(dir);
  assert.equal(p.testFiles.length, 1, 'a _test.go file must be recognised as a test');
  assert.ok(p.testFiles[0].endsWith('decode_test.go'));
});

test('maps a Go test to its sibling source without imports', async (t) => {
  // Go test files sit beside the source and call it directly; there is no import
  // statement to resolve, so name and directory are the only signal.
  const dir = await mkdtemp(join(tmpdir(), 'crucible-go2-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'go.mod'), 'module example.com/x\n');
  await writeFile(join(dir, 'decode.go'), 'package x\nfunc Decode() { return }\n');
  await writeFile(join(dir, 'decode_test.go'), 'package x\nfunc TestDecode(t *T) { Decode() }\n');

  const p = await discover(dir);
  const src = p.sourceFiles.find((f) => f.endsWith('decode.go'));
  assert.ok(src, 'decode.go must be found as source');
  const covering = p.covers.get(src) ?? [];
  assert.equal(covering.length, 1, 'decode_test.go must be mapped to decode.go');
});

test('a Go package test covers every non-test file in that package', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-go-package-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'go.mod'), 'module example.com/x\n');
  await writeFile(join(dir, 'binding.go'), 'package x\nfunc Bind() {}\n');
  await writeFile(join(dir, 'form.go'), 'package x\nfunc Form() {}\n');
  await writeFile(join(dir, 'binding_test.go'), 'package x\nfunc TestBind(t *T) { Bind(); Form() }\n');

  const p = await discover(dir);
  assert.equal(p.covers.get(join(dir, 'binding.go')).length, 1);
  assert.equal(p.covers.get(join(dir, 'form.go')).length, 1,
    'Go compiles all package files into the same test binary');
});

test('recognises Rust test files', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-rs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'Cargo.toml'), '[package]\nname = "x"\n');
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'tests'), { recursive: true });
  await writeFile(join(dir, 'src/lib.rs'), 'pub fn f() {}\n');
  await writeFile(join(dir, 'tests/basic_test.rs'), '#[test]\nfn t() {}\n');

  const p = await discover(dir);
  assert.ok(p.testFiles.some((f) => f.endsWith('basic_test.rs')));
});

test('a missing runner is reported as missing, not as a red suite', async (t) => {
  // Telling the user "suite is red" when the runner is not installed sends them
  // looking for a broken test that does not exist.
  const dir = await mkdtemp(join(tmpdir(), 'crucible-miss-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const result = await baseline({ root: dir, command: 'definitely-not-a-real-runner-xyz', timeoutMs: 10_000 });
  assert.equal(result.green, false);
  assert.equal(result.missing, true, 'must distinguish a missing runner from a failing suite');
  assert.match(result.hint, /not installed/);
});

test('a genuinely failing suite is not reported as missing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-red-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'a.test.js'),
    "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('x', () => { assert.equal(1, 2); });\n");

  const result = await baseline({ root: dir, command: 'node --test a.test.js', timeoutMs: 30_000 });
  assert.equal(result.green, false);
  assert.equal(result.missing, false, 'a real assertion failure is not a missing runner');
});
