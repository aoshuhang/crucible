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
import { join } from 'node:path';
import { comparisonsIn, boundaryValues, boundarySensitive, resolveConstant } from './boundary-values.js';
import { exportedNames, buildBoundaryTest, buildBoundaryProbe, parseProbeOutput, placement, suggestManualBoundary } from './fix.js';
import { run } from './judge.js';

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
export function mapComparisonsToFunctions(source) {
  const lines = source.split('\n');
  const names = exportedNames(source);

  // Locate each exported function's line span.
  const spans = [];
  for (const name of names) {
    const patterns = [
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

    // Span: from the start line to the matching closing brace at column 0.
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
export async function fixBoundaries({ root, sourceFile, testFiles, runner, runnerName }) {
  const source = await readFile(sourceFile, 'utf8');
  const mapped = mapComparisonsToFunctions(source);

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

  const { fixPath, importPath, dir, probeName } = placement({ sourceFile, testFiles, root });
  const probePath = join(dir, probeName);

  try {
    const probeBody = buildBoundaryProbe({ importPath, cases });
    await writeFile(probePath, probeBody, 'utf8');

    // Run the probe directly with node: it must not go through the project's test
    // runner, which would skip it when crucible itself runs inside a test process.
    const probeRun = await run(`node ${JSON.stringify(probePath)}`, root, 60_000);
    const probed = parseProbeOutput(probeRun.stdout + probeRun.stderr);

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
      sourceName: sourceFile.split('/').pop().replace(/\.[^.]+$/, ''),
      runner,
      cases: usable,
    });

    await writeFile(fixPath, body, 'utf8');
    return { written: fixPath, cases: usable.length };
  } finally {
    await rm(probePath, { force: true });
  }
}
