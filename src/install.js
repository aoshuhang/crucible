/**
 * Install the agent skill that ships inside this package.
 *
 * npm copies only what `files` lists, so the skill travels next to bin/ and src/.
 * This is a command rather than a sentence in the README because a skill copy that
 * is one release stale is worse than none: the agent keeps following instructions
 * for flags that no longer exist. `crucible install` re-copies when the packaged
 * skill changed, and refuses to clobber a file the user edited by hand.
 */

import { cp, lstat, mkdir, readdir, readFile, readlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_NAME = 'crucible';

/** The skill as it sits on disk: <package>/skills/crucible. */
export function packagedSkillDir() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', SKILL_NAME);
}

/**
 * Where an agent looks for skills.
 *
 * Only agents that are actually installed get a copy: creating `~/.claude` for
 * someone who has never run Claude Code would be a surprise, not a feature. When
 * neither is present we fall back to OpenCode, the layout the README documents
 * first, so `crucible install` always does something useful on a clean machine.
 */
export function defaultSkillTargets(home = homedir()) {
  const agents = [
    { agent: 'OpenCode', base: join(home, '.config', 'opencode') },
    { agent: 'Claude Code', base: join(home, '.claude') },
  ];
  const present = agents.filter((a) => existsSync(a.base));
  const chosen = present.length > 0 ? present : [agents[0]];
  return chosen.map((a) => ({ agent: a.agent, target: join(a.base, 'skills', SKILL_NAME) }));
}

async function filesIn(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await filesIn(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/**
 * Which files the packaged copy would change on disk.
 *
 * Extra files in the target are left alone: a reader who added their own notes
 * should not lose them because we only ship one markdown file.
 */
async function staleFiles(source, target) {
  const wanted = await filesIn(source);
  const present = new Set(await filesIn(target).catch(() => []));
  const changed = [];
  for (const rel of wanted) {
    if (!present.has(rel)) {
      changed.push(rel);
      continue;
    }
    const [shipped, onDisk] = await Promise.all([
      readFile(join(source, rel)),
      readFile(join(target, rel)),
    ]);
    if (!shipped.equals(onDisk)) changed.push(rel);
  }
  return { wanted, changed, presentCount: present.size };
}

/**
 * Copy the skill to one target.
 *
 * A symlink is reported and left untouched: that is how a contributor runs the
 * checkout, and replacing the link with a copy would silently stop their edits from
 * reaching the agent.
 */
export async function installSkill(target, { source = packagedSkillDir(), force = false } = {}) {
  if (!existsSync(source)) return { target, status: 'no-source' };

  let info = null;
  try {
    info = await lstat(target);
  } catch {
    info = null;
  }

  if (info?.isSymbolicLink()) {
    return { target, status: 'symlink', link: await readlink(target) };
  }
  if (info && !info.isDirectory()) return { target, status: 'not-a-directory' };

  let fresh = !info;
  if (info) {
    const { wanted, changed, presentCount } = await staleFiles(source, target);
    // An empty directory is a first install, not a conflict: someone who ran
    // `mkdir -p` first should not be told to pass --force.
    fresh = presentCount === 0;
    if (!fresh) {
      if (changed.length === 0) return { target, status: 'current', files: wanted.length };
      if (!force) return { target, status: 'conflict', changed };
    }
  }

  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: true });
  return { target, status: fresh ? 'installed' : 'replaced' };
}
