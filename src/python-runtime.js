import { spawnSync } from 'node:child_process';

/**
 * Python executable used by discovery, mutation and probes.
 *
 * Windows installs normally expose `python`, while POSIX installs commonly expose
 * `python3`. CRUCIBLE_PYTHON overrides both for unusual environments.
 */
export function pythonCommand() {
  return process.env.CRUCIBLE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

export function pythonAvailable() {
  try {
    const result = spawnSync(pythonCommand(), ['-I', '-c', 'import sys; print(sys.version_info[0])'], {
      encoding: 'utf8', timeout: 10_000,
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}
