import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { installSkill, defaultSkillTargets, packagedSkillDir } from '../src/install.js';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/crucible.js', import.meta.url));

/**
 * `crucible install` exists because the skill and the program must be the same
 * release. A copy that lags behind keeps telling an agent about flags that changed,
 * and nothing in the agent's own output says so.
 */

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crucible-install-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('copies the packaged skill into an empty target', async (t) => {
  const dir = await scratch(t);
  const target = join(dir, 'skills', 'crucible');

  const result = await installSkill(target);
  assert.equal(result.status, 'installed');

  const shipped = await readFile(join(packagedSkillDir(), 'SKILL.md'), 'utf8');
  assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), shipped);
});

test('an empty directory is a first install, not a conflict', async (t) => {
  const dir = await scratch(t);
  const target = join(dir, 'skills', 'crucible');
  await mkdir(target, { recursive: true });

  // `mkdir -p` before installing is normal; asking for --force there would be a lie.
  assert.equal((await installSkill(target)).status, 'installed');
  assert.equal((await installSkill(target)).status, 'current');
});

test('a second run is a no-op, not a rewrite', async (t) => {
  const dir = await scratch(t);
  const target = join(dir, 'skills', 'crucible');

  assert.equal((await installSkill(target)).status, 'installed');
  assert.equal((await installSkill(target)).status, 'current');
});

test('an edited copy is reported and left alone until --force', async (t) => {
  const dir = await scratch(t);
  const target = join(dir, 'skills', 'crucible');
  await installSkill(target);

  await writeFile(join(target, 'SKILL.md'), 'my own instructions\n');
  const blocked = await installSkill(target);
  assert.equal(blocked.status, 'conflict');
  assert.deepEqual(blocked.changed, ['SKILL.md']);
  assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), 'my own instructions\n',
    'without --force the reader keeps their edit');

  const forced = await installSkill(target, { force: true });
  assert.equal(forced.status, 'replaced');
  const shipped = await readFile(join(packagedSkillDir(), 'SKILL.md'), 'utf8');
  assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), shipped);
});

test('extra files next to the skill survive a forced update', async (t) => {
  const dir = await scratch(t);
  const target = join(dir, 'skills', 'crucible');
  await installSkill(target);
  await writeFile(join(target, 'NOTES.md'), 'notes\n');
  await writeFile(join(target, 'SKILL.md'), 'stale\n');

  assert.equal((await installSkill(target, { force: true })).status, 'replaced');
  assert.equal(await readFile(join(target, 'NOTES.md'), 'utf8'), 'notes\n');
});

test('a symlinked skill is reported, never replaced', async (t) => {
  const dir = await scratch(t);
  const checkout = join(dir, 'checkout');
  await mkdir(checkout, { recursive: true });
  await writeFile(join(checkout, 'SKILL.md'), 'from the checkout\n');

  const target = join(dir, 'skills', 'crucible');
  await mkdir(join(dir, 'skills'), { recursive: true });
  await symlink(checkout, target);

  const result = await installSkill(target, { force: true });
  assert.equal(result.status, 'symlink');
  assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), 'from the checkout\n',
    'a contributor links the checkout; a copy would silently freeze it');
});

test('a plain file in the way is an error, not a silent overwrite', async (t) => {
  const dir = await scratch(t);
  const target = join(dir, 'skills');
  await mkdir(dir, { recursive: true });
  await writeFile(target, 'not a directory\n');

  const result = await installSkill(target);
  assert.equal(result.status, 'not-a-directory');
  assert.equal(await readFile(target, 'utf8'), 'not a directory\n');
});

test('a package published without the skill says so', async (t) => {
  const dir = await scratch(t);
  const result = await installSkill(join(dir, 'skills', 'crucible'), { source: join(dir, 'missing') });
  assert.equal(result.status, 'no-source');
});

test('targets follow the agents that are actually installed', async (t) => {
  const home = await scratch(t);

  // Neither agent present: fall back to the layout the README documents first.
  assert.deepEqual(defaultSkillTargets(home), [
    { agent: 'OpenCode', target: join(home, '.config/opencode/skills/crucible') },
  ]);

  await mkdir(join(home, '.claude'), { recursive: true });
  assert.deepEqual(defaultSkillTargets(home), [
    { agent: 'Claude Code', target: join(home, '.claude/skills/crucible') },
  ]);

  await mkdir(join(home, '.config/opencode'), { recursive: true });
  const both = defaultSkillTargets(home);
  assert.deepEqual(both.map((x) => x.agent), ['OpenCode', 'Claude Code'],
    'both agents get a copy when both are installed');
});

test('the command exits 0 when it installs and 1 when it must not overwrite', async (t) => {
  const dir = await scratch(t);
  const target = join(dir, 'skills', 'crucible');

  const first = await run(process.execPath, [CLI, 'install', `--dir=${target}`]);
  assert.match(first.stdout, /installed/);

  await writeFile(join(target, 'SKILL.md'), 'edited\n');
  await assert.rejects(
    run(process.execPath, [CLI, 'install', `--dir=${target}`]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /differs/);
      assert.match(error.stdout, /--force/);
      return true;
    },
  );
});
