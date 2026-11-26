/**
 * Boundary fix orchestration.
 *
 * The chain: find comparisons → find the exported function that guards each one →
 * resolve the threshold → probe the real return values at below/at/above →
 * emit a test that pins those exact values.
 *
 * Every step can fail, and every failure is reported instead of guessed around.
 */

import { readFile, writeFile, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { comparisonsIn, boundaryValues, boundarySensitive } from './boundary-values.js';
import { exportedNames, buildBoundaryTest, buildBoundaryProbe, parseProbeOutput, placement, suggestManualBoundary } from './fix.js';
import { run, addFailFast, registerTempFile, unregisterTempFile } from './judge.js';
import { mayWrite, stamp } from './guard.js';
import { stem, relPosix } from './paths.js';

/**
 * Read the real return values at the boundary.
 *
 * Plain JavaScript resolves under `node` directly, which is fast and cannot run
 * the whole suite. TypeScript (and JSX) only resolve under the project's own
 * runner — crucible strips the extension from the generated import so the
 * bundler-style resolver the tests use can find the file, and plain `node` cannot
 * resolve an extensionless specifier. Running it anyway used to fail with
 * ERR_MODULE_NOT_FOUND and made every TS boundary fix silently fall back.
 */
async function probeValues({ root, sourceFile, probePath, runnerName, fullCommand }) {
  const ext = extname(sourceFile).toLowerCase();
  const plainJs = ext === '.js' || ext === '.mjs' || ext === '.cjs';

  if (plainJs) {
    const result = await run(`node ${JSON.stringify(probePath)}`, root, 60_000);
    return parseProbeOutput(result.stdout + result.stderr);
  }

  const rel = relPosix(root, probePath);
  const narrow = runnerName === 'vitest'
    ? `./node_modules/.bin/vitest run ${JSON.stringify(rel)}`
    : runnerName === 'jest'
      ? `./node_modules/.bin/jest ${JSON.stringify(rel)} --ci`
      : `node --test ${JSON.stringify(rel)}`;

  const narrowRun = await run(narrow, root, 120_000);
  const parsed = parseProbeOutput(narrowRun.stdout + narrowRun.stderr);
  if (parsed) return parsed;

  // Last resort: the project's own test command, which certainly understands its
  // language. The probe is a `.test` file, so it is picked up by the suite glob.
  if (fullCommand) {
    const fullRun = await run(addFailFast(fullCommand), root, 180_000);
    return parseProbeOutput(fullRun.stdout + fullRun.stderr);
  }
  return null;
}

/**
 * Only comparisons whose function takes a numeric argument can be fixed
 * mechanically. `decideState(perception)` needs an object; feeding it 9, 10, 11
 * throws, and pretending otherwise would produce a test that always errors.
 *
 * We report those as manual work instead of writing a broken test.
 */
function takesNumericArgument(source, fnName) {
  const patterns = [
    new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${fnName}\\s*\\(\\s*([\\w$]+)`),
    new RegExp(`(?:export\\s+)?const\\s+${fnName}\\s*=\\s*(?:async\\s*)?\\(\\s*([\\w$]+)`),
    // Python
    new RegExp(`^[ \\t]*(?:async[ \\t]+)?def[ \\t]+${fnName}[ \\t]*\\([ \\t]*([\\w$]+)`, 'm'),
  ];

  for (const re of patterns) {
    const m = source.match(re);
    if (!m) continue;
    const param = m[1];

    // A numeric parameter is one used directly in a comparison on its own.
    const usedInComparison = new RegExp(`\\b${param}\\s*[<>]=?|\\b${param}\\s*(?:===?|!==?)`).test(source);
    const usedAsObject = new RegExp(`\\b${param}\\.[A-Za-z_]`).test(source);

    return usedInComparison && !usedAsObject;
  }

  return false;
}
/**
 * Is this a Python source file?
 * Detection is by the caller's file path; the source text alone is ambiguous.
 */
export function isPython(filePath = '') {
  return /\.py$/.test(filePath);
}

/**
 * Locate a Python function's line span.
 *
 * Python has no closing brace, so the span runs from the `def` line to the last
 * line of the block — that is, the last non-blank line indented deeper than the
 * `def`, plus any blank lines inside it. Getting this wrong means a comparison in
 * one function is attributed to another.
 *
 * @returns {{ start: number, end: number } | null} 1-based, inclusive
 */
export function pythonFunctionSpan(lines, defLineIndex) {
  const defLine = lines[defLineIndex] ?? '';
  const defIndent = defLine.match(/^\s*/)[0].length;

  let end = defLineIndex;
  let bodyIndent = null;

  for (let i = defLineIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue; // blank lines inside the body are fine

    const indent = line.match(/^\s*/)[0].length;

    // A line at or left of the def's indentation ends the function.
    if (indent <= defIndent) break;

    if (bodyIndent === null) bodyIndent = indent;
    end = i;
  }

  // A `def` with an empty body still owns its own line.
  return { start: defLineIndex + 1, end: end + 1 };
}

export function mapComparisonsToFunctions(source, filePath = '') {
  const lines = source.split('\n');
  const names = exportedNames(source);
  const python = isPython(filePath) || /\bdef\s+\w+\s*\([^)]*\)\s*:/.test(source);

  // Locate each exported function's line span.
  const spans = [];
  for (const name of names) {
    const patterns = python
      // `[ \t]*` not `\s*`: `\s` matches newlines, so with the multiline flag the
      // match starts on the previous line and the computed line number is one off.
      ? [new RegExp(`^[ \\t]*(?:async\\s+)?def[ \\t]+${name}[ \\t]*\\(`, 'm')]
      : [
        new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\s*\\(`),
        new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(?:async\\s*)?\\(`),
      ];

    let start = -1;
    for (const re of patterns) {
      const m = source.match(re);
      if (m) {
        start = source.slice(0, m.index).split('\n').length;
        break;
      }
    }
    if (start === -1) continue;

    if (python) {
      const span = pythonFunctionSpan(lines, start - 1);
      if (span) spans.push({ name, ...span });
      continue;
    }

    // JS/TS: from the start line to the matching closing brace at column 0.
    let end = lines.length;
    for (let i = start; i < lines.length; i += 1) {
      if (/^}/.test(lines[i])) { end = i + 1; break; }
    }
    spans.push({ name, start, end });
  }

  const out = [];
  for (const cmp of comparisonsIn(source)) {
    if (!boundarySensitive(cmp.op)) continue;

    const owner = spans.find((s) => cmp.line >= s.start && cmp.line <= s.end);
    if (!owner) continue;

    out.push({ fn: owner.name, comparison: cmp });
  }

  return out;
}

/**
 * Build and run the boundary fix for one source file.
 * @returns {Promise<{ written: string|null, cases: number, reason?: string }>}
 */
export async function fixBoundaries(options) {
  const { root, sourceFile, testFiles, runner, runnerName } = options;
  const source = await readFile(sourceFile, 'utf8');
  const mapped = mapComparisonsToFunctions(source, sourceFile);

  if (mapped.length === 0) {
    return { written: null, cases: 0, reason: 'no boundary comparison inside an exported function' };
  }

  // Group by function, one case per comparison, resolving constants as we go.
  const cases = [];
  const skippedFns = [];

  for (const { fn, comparison } of mapped) {
    if (!takesNumericArgument(source, fn)) {
      if (!skippedFns.includes(fn)) skippedFns.push(fn);
      continue;
    }

    const values = boundaryValues({ comparison, source });
    if (!values) continue;

    cases.push({
      fn,
      op: comparison.op,
      constantName: comparison.right,
      values,
    });
  }

  if (cases.length === 0) {
    const manual = skippedFns.length > 0
      ? mapComparisonsToFunctions(source)
        .filter((m) => skippedFns.includes(m.fn))
        .map((m) => suggestManualBoundary({
          fn: m.fn,
          comparison: m.comparison,
          sourceLines: source.split('\n'),
        }))
      : [];

    return {
      written: null,
      cases: 0,
      manual,
      reason: skippedFns.length > 0
        ? `${skippedFns.join(', ')} take a non-numeric argument, so the boundary needs a hand-written case`
        : 'no numeric threshold could be resolved',
    };
  }

  const { fixPath, importPath, dir, probeName, python } = placement({ sourceFile, testFiles, root });

  // Plain JavaScript probes run under `node` directly, so the file must be ESM no
  // matter what the package's `type` says; `.js` in a CommonJS package is parsed as
  // CJS and fails on its own import statement. TypeScript keeps the runner-visible
  // name, and Python keeps its `.py` probe.
  const plainJs = !python && /\.(js|mjs|cjs)$/i.test(sourceFile);
  const probePath = join(dir, plainJs ? '__crucible_boundary.probe.mjs' : probeName);
  registerTempFile(probePath);

  try {
    if (python) {
      const { buildPythonProbe, buildPythonBoundaryTest } = await import('./python.js');
      const pyProbe = buildPythonProbe({ importPath, cases });
      await writeFile(probePath, pyProbe, 'utf8');

      const pyRun = await run(`python3 ${JSON.stringify(probePath)}`, root, 60_000);

      let probed = null;
      const marker = 'CRUCIBLE_PROBE';
      const idx = (pyRun.stdout + pyRun.stderr).indexOf(marker);
      if (idx !== -1) {
        const tail = (pyRun.stdout + pyRun.stderr).slice(idx + marker.length);
        const end = tail.lastIndexOf(']');
        if (end !== -1) {
          try { probed = JSON.parse(tail.slice(0, end + 1)); } catch { probed = null; }
        }
      }

      if (!probed || probed.length === 0) {
        return { written: null, cases: 0, reason: 'probe produced no values' };
      }

      let cursor = 0;
      for (const c of cases) {
        c.observed = [];
        for (let i = 0; i < 3; i += 1) {
          const entry = probed[cursor];
          cursor += 1;
          c.observed.push(entry && !entry.error ? entry.value : undefined);
        }
      }

      const usablePy = cases.filter((c) => c.observed.some((v) => v !== undefined));
      if (usablePy.length === 0) {
        return { written: null, cases: 0, reason: 'every boundary call raised' };
      }

      const distinctPy = new Set(usablePy.flatMap((c) => c.observed.map((v) => JSON.stringify(v))));
      if (distinctPy.size < 2) {
        return {
          written: null,
          cases: 0,
          reason: 'all three boundary points return the same value, so a test here would catch nothing',
        };
      }

      const pyBody = buildPythonBoundaryTest({
        importPath,
        sourceName: stem(sourceFile),
        cases: usablePy,
      });

      const pyGate = await mayWrite(fixPath, { force: options.force });
      if (!pyGate.write) return { written: null, cases: 0, reason: pyGate.reason };
      await writeFile(fixPath, stamp(pyBody, 'py'), 'utf8');
      return { written: fixPath, cases: usablePy.length };
    }

    const probeBody = buildBoundaryProbe({ importPath, cases });
    await writeFile(probePath, probeBody, 'utf8');

    const probed = await probeValues({
      root,
      sourceFile,
      probePath,
      runnerName,
      fullCommand: runner,
    });

    if (!probed || probed.length === 0) {
      return { written: null, cases: 0, reason: 'probe produced no values (does the function take a number?)' };
    }

    // Attach observed values to each case, in the order we probed them.
    let cursor = 0;
    for (const c of cases) {
      c.observed = [];
      for (let i = 0; i < 3; i += 1) {
        const entry = probed[cursor];
        cursor += 1;
        c.observed.push(entry && !entry.error ? entry.value : undefined);
      }
    }

    const usable = cases.filter((c) => c.observed.some((v) => v !== undefined));
    if (usable.length === 0) {
      return { written: null, cases: 0, reason: 'every boundary call threw' };
    }

    const body = buildBoundaryTest({
      importPath,
      sourceName: stem(sourceFile),
      runner: runnerName,
      cases: usable,
    });

    const jsGate = await mayWrite(fixPath, { force: options.force });
    if (!jsGate.write) return { written: null, cases: 0, reason: jsGate.reason };

    await writeFile(fixPath, stamp(body, 'js'), 'utf8');
    return { written: fixPath, cases: usable.length };
  } finally {
    await rm(probePath, { force: true });
    unregisterTempFile(probePath);
  }
}
