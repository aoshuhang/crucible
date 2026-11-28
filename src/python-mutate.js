/**
 * Python mutation operators.
 *
 * The heavy lifting lives in src/python_ast.py: Node spawns it with `python3 -I`,
 * passes the source on stdin, and receives byte-accurate AST/tokenize spans back.
 * The helper never imports the target module, and every candidate is parse-checked
 * before it is returned, so a failed mutant is dropped instead of being counted as
 * killed for the wrong reason.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pythonCommand } from './python-runtime.js';

const HELPER_PATH = fileURLToPath(new URL('./python_ast.py', import.meta.url));

/** @typedef {{ id: string, kind: string, line: number, column: number, original: string, mutated: string, description: string, language: 'python' }} PythonMutation */

let helperAvailable = null;
let helperProbeError = null;

/**
 * Can this machine run the AST helper? Probe once, cheaply.
 * @returns {{ available: boolean, parseError: string|null }}
 */
function pythonAvailability() {
  if (helperAvailable !== null) return { available: helperAvailable, parseError: helperProbeError };

  const probe = spawnSync(pythonCommand(), ['-I', HELPER_PATH], {
    input: '',
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });

  if (probe.error) {
    helperAvailable = false;
    helperProbeError = probe.error.code === 'ENOENT'
      ? 'python3 is not available on PATH'
      : `failed to launch python3: ${probe.error.message}`;
    return { available: false, parseError: helperProbeError };
  }

  helperAvailable = probe.status === 0;
  helperProbeError = helperAvailable
    ? null
    : `python3 exited with status ${probe.status}${probe.signal ? ` after ${probe.signal}` : ''}`;
  return { available: helperAvailable, parseError: helperProbeError };
}

/**
 * Run the helper and normalize both success and failure into an honest report.
 * @returns {{ mutations: PythonMutation[], parseError: string|null, available: boolean }}
 */
export function pythonMutationsDetailed(source, fileLabel = 'source.py', options = {}) {
  const availability = pythonAvailability();
  if (!availability.available) {
    return { mutations: [], parseError: availability.parseError, available: false };
  }

  const profile = options.profile === 'strict' ? 'strict' : 'logic';
  const result = spawnSync(pythonCommand(), ['-I', HELPER_PATH, profile], {
    input: typeof source === 'string' ? source : '',
    encoding: 'utf8',
    timeout: options.timeout ?? 20_000,
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.error) {
    const parseError = result.error.code === 'ENOENT'
      ? 'python3 is not available on PATH'
      : `failed to run python AST helper: ${result.error.message}`;
    return { mutations: [], parseError, available: false };
  }

  if (result.signal === 'SIGTERM') {
    return { mutations: [], parseError: 'python AST helper timed out', available: true };
  }

  if (result.status !== 0) {
    const detail = (result.stderr || '').trim();
    return {
      mutations: [],
      parseError: `python AST helper exited with status ${result.status}${detail ? `: ${detail}` : ''}`,
      available: true,
    };
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout || '{}');
  } catch (error) {
    return { mutations: [], parseError: `python AST helper returned invalid JSON: ${error.message}`, available: true };
  }

  if (payload.parseError) {
    return { mutations: [], parseError: payload.parseError, available: true };
  }

  const raw = Array.isArray(payload.mutations) ? payload.mutations : [];
  const mutations = [];
  const seen = new Set();

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const line = Number(item.line);
    const column = Number(item.column);
    if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) continue;
    if (typeof item.original !== 'string' || typeof item.mutated !== 'string') continue;

    const id = `${fileLabel}:${line}:${column}:${item.kind}`;
    if (seen.has(id)) continue;
    seen.add(id);

    mutations.push({
      id,
      kind: typeof item.kind === 'string' ? item.kind : 'unknown',
      line,
      column,
      original: item.original,
      mutated: item.mutated,
      description: typeof item.description === 'string' ? item.description : 'mutate python source',
      language: 'python',
    });
  }

  return { mutations, parseError: null, available: true };
}

/**
 * Yield mutation candidates for one Python file's source text.
 * The shape matches src/mutate.js: `mutated` is the whole replacement line, and
 * `line`/`column` are 1-based.
 *
 * @param {string} source
 * @param {string} [fileLabel]
 * @param {{ timeout?: number }} [options]
 * @returns {PythonMutation[]}
 */
export function pythonMutations(source, fileLabel = 'source.py', options = {}) {
  return pythonMutationsDetailed(source, fileLabel, options).mutations;
}
