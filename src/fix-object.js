/**
 * Boundary fixing for object arguments.
 *
 * The hard case, and the one that decides whether this tool is useful on real
 * code: `threat.distance <= p.sightRange` cannot be probed by calling
 * `decideState(9)`. The function takes a shape.
 *
 * The solution is not to synthesise a shape from the type signature. It is to
 * reuse what the project's own tests already build: they construct a `base`
 * perception and spread it with overrides. If a test already knows how to make a
 * valid argument, we can make the same argument with one field moved to the
 * boundary.
 *
 * So we harvest object literals from the covering tests, find the one whose field
 * paths match the comparison's operands, and emit a test that spreads it with the
 * boundary value substituted.
 */

import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { placement, parseProbeOutput } from './fix.js';
import { run } from './judge.js';

/**
 * Extract `const NAME: Type = { ... };` literals from a test file.
 * Returns the name, the type annotation and the raw object text.
 * @returns {{ name: string, type: string|null, text: string }[]}
 */
export function harvestObjectLiterals(testSource) {
  const out = [];
  const re = /const\s+(\w+)\s*(?::\s*([\w<>[\]|]+))?\s*=\s*\{/g;

  let m;
  while ((m = re.exec(testSource)) !== null) {
    const name = m[1];
    const type = m[2] ?? null;
    const braceStart = testSource.indexOf('{', m.index + m[0].length - 1);

    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < testSource.length; i += 1) {
      if (testSource[i] === '{') depth += 1;
      else if (testSource[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) continue;

    const text = testSource.slice(braceStart, end + 1);
    // Only top-level scalars matter for field paths; nested literals are skipped
    // because we cannot reason about their shape.
    if (text.length > 4000) continue;

    out.push({ name, type, text });
  }

  return out;
}

/**
 * Top-level field names of an object literal, e.g. `{ healthFrac: 1, carnivore: true }`
 * yields ['healthFrac', 'carnivore'].
 */
export function fieldNames(objectText) {
  const inner = objectText.slice(1, -1);
  const names = [];
  let depth = 0;

  let token = '';
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;

    if (ch === ',' && depth === 0) {
      const key = token.match(/^\s*(\w+)\s*:/);
      if (key) names.push(key[1]);
      token = '';
      continue;
    }
    token += ch;
  }
  const key = token.match(/^\s*(\w+)\s*:/);
  if (key) names.push(key[1]);

  return names;
}

/**
 * Which field of the argument does this comparison's left side read?
 *
 * `state.count > MAX` → the argument has a `count` field.
 * `threat.distance <= sight` → the argument has a `threat` field whose shape has
 * `distance`.
 *
 * So the candidate field is the LAST path segment when the object is flat
 * (`state.count` where `state` is the parameter name), and the FIRST segment when
 * the parameter name is the function's argument (`threat.distance` where `p` is
 * the parameter and `threat` is the field).
 *
 * We try both, cheapest first: a field named like the last segment, then one named
 * like the first.
 */
export function candidateFields(expression) {
  const parts = expression.split('.').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 1) return [parts[0]];
  // `state.count` → try 'count' then 'state'; `threat.distance` → 'distance' then 'threat'.
  return [parts[parts.length - 1], parts[0]];
}

/** Backwards-compatible single-answer helper. */
export function ownerField(expression) {
  return candidateFields(expression)[0];
}

/**
 * Find the test object that can carry a boundary value for this comparison.
 *
 * Two shapes matter:
 *   - the operand is a direct field of the base object (`p.selfPower`)
 *   - the operand is a field of a nested object the test supplies (`threat.distance`)
 *
 * In the first case we override the field on the base. In the second we override
 * the whole nested object, keeping the test's own construction style.
 *
 * @returns {{ base: string, kind: 'direct'|'nested', field: string, literal: {name:string,text:string} } | null}
 */
export function chooseCarrier({ comparison, literals }) {
  const candidates = candidateFields(comparison.left);

  // Flat case: a field with the same name as the operand's last segment.
  for (const name of candidates) {
    for (const lit of literals) {
      const fields = fieldNames(lit.text);
      if (fields.includes(name)) {
        return { base: lit.name, kind: 'direct', field: name, literal: lit };
      }
    }
  }

  // Nested case: the test spreads `{ ...base, nearestThreat: {...} }`, so the
  // carrier is the base object and we override the nested field wholesale.
  for (const name of candidates) {
    for (const lit of literals) {
      const fields = fieldNames(lit.text);
      const match = fields.find((f) => f.toLowerCase().includes(name.toLowerCase()));
      if (match) {
        return { base: lit.name, kind: 'nested', field: match, literal: lit };
      }
    }
  }

  return null;
}

/**
 * The threshold value for a comparison.
 *
 * Three cases, in order:
 *   1. a numeric literal (`count >= 10`)
 *   2. a module constant (`count >= MAX`)
 *   3. a field of the argument object (`threat.distance <= p.sightRange`), where the
 *      value lives in the object the tests already construct
 */
export function thresholdOf({ comparison, source, literals = [] }) {
  const asNumber = Number(comparison.right);
  if (Number.isFinite(asNumber)) return asNumber;

  // A module constant.
  const re = new RegExp(`(?:export\\s+)?const\\s+${comparison.right}\\s*=\\s*(-?[\\d.]+)\\b`);
  const m = source.match(re);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) return n;
  }

  // A field of the argument object: `p.sightRange` → look for `sightRange: 15`.
  const fieldName = comparison.right.split('.').pop();
  for (const lit of literals) {
    const fieldRe = new RegExp(`\\b${fieldName}\\s*:\\s*(-?[\\d.]+)\\b`);
    const fm = lit.text.match(fieldRe);
    if (fm) {
      const n = Number(fm[1]);
      if (Number.isFinite(n)) return n;
    }
  }

  return null;
}

/**
 * Build a probe that spreads the harvested base object with the boundary value.
 *
 * For `threat.distance <= p.sightRange` with base `{sightRange: 15}` we emit calls
 * with a threat at distance 14, 15 and 16, which is exactly what distinguishes
 * `<=` from `<`.
 */
export function buildObjectProbe({ importPath, fn, baseName, baseText, kind, field, points, nestedValue, runner }) {
  const lines = [];
  lines.push('// generated by crucible — temporary object-boundary probe, safe to delete');
  lines.push(`import * as mod from '${importPath}';`);
  lines.push(`const base = ${baseText};`);
  lines.push('const out = [];');

  for (const p of points) {
    const arg = kind === 'direct'
      ? `{ ...base, ${field}: ${p} }`
      : `{ ...base, ${field}: ${nestedValue(p)} }`;
    lines.push('try {');
    lines.push(`  out.push({ input: ${p}, value: mod.${fn}(${arg}) });`);
    lines.push('} catch (e) {');
    lines.push(`  out.push({ input: ${p}, error: String(e && e.message) });`);
    lines.push('}');
  }

  lines.push("console.log('CRUCIBLE_PROBE' + JSON.stringify(out));");
  return lines.join('\n');
}

/**
 * Emit the permanent test for an object boundary.
 */
export function buildObjectTest({ importPath, fn, sourceName, runner, baseText, kind, field, points, nestedValue, observed, comparison }) {
  const isVitest = runner === 'vitest' || runner === 'jest';
  const lines = [];

  lines.push(`// Boundary test for ${sourceName}.${fn}.`);
  lines.push(`// Generated by crucible: ${comparison.left} ${comparison.op} ${comparison.right}`);
  lines.push('// differs from its neighbour only at equality, and no existing test supplies');
  lines.push('// that exact case.');
  if (isVitest) {
    lines.push("import { describe, expect, it } from 'vitest';");
  } else {
    lines.push("import { describe, it } from 'node:test';");
    lines.push("import assert from 'node:assert/strict';");
  }
  lines.push(`import * as mod from '${importPath}';`);
  lines.push('');
  lines.push(`const base = ${baseText};`);
  lines.push('');
  lines.push(`describe('${sourceName}.${fn} at the ${comparison.right} boundary', () => {`);

  const labels = ['one below the threshold', 'exactly at the threshold', 'one above the threshold'];

  for (let i = 0; i < points.length; i += 1) {
    const v = observed[i];
    if (v === undefined) continue;

    const arg = kind === 'direct'
      ? `{ ...base, ${field}: ${points[i]} }`
      : `{ ...base, ${field}: ${nestedValue(points[i])} }`;

    lines.push(`  it('${labels[i]} (${points[i]}) returns ${JSON.stringify(v)}', () => {`);
    if (typeof v === 'number') {
      lines.push(isVitest
        ? `    expect(mod.${fn}(${arg})).toBeCloseTo(${v}, 6);`
        : `    assert.ok(Math.abs(mod.${fn}(${arg}) - ${v}) < 1e-6);`);
    } else {
      lines.push(isVitest
        ? `    expect(mod.${fn}(${arg})).toBe(${JSON.stringify(v)});`
        : `    assert.equal(mod.${fn}(${arg}), ${JSON.stringify(v)});`);
    }
    lines.push('  });');
    lines.push('');
  }

  lines.push('});');
  return lines.join('\n');
}

/**
 * Resolve a module constant to its number, following imports across files.
 *
 * `size >= MAX_SIZE` where `MAX_SIZE` is imported from another module is the
 * common case in any real codebase, so this has to look beyond the current file.
 *
 * @param {object} opts
 * @param {string} opts.name      the identifier
 * @param {string} opts.source    the file that uses it
 * @param {string} opts.file      absolute path of that file
 * @param {(p: string) => Promise<string|null>} opts.read
 * @returns {Promise<number|null>}
 */
export async function resolveConstantDeep({ name, source, file, read }) {
  // Defined locally?
  const local = source.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*(-?[\\d.]+)\\b`));
  if (local) {
    const n = Number(local[1]);
    if (Number.isFinite(n)) return n;
  }

  // Imported? Find the specifier and read that file.
  const importRe = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]([^'"]+)['"]`, 'g');
  let m;
  while ((m = importRe.exec(source)) !== null) {
    const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop().trim());
    if (!names.includes(name)) continue;

    const spec = m[2];
    if (!spec.startsWith('.')) continue;

    const dir = file.slice(0, file.lastIndexOf('/'));
    const base = `${dir}/${spec}`.replace(/\/\.\//g, '/');

    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`, `${base}/index.js`]) {
      const text = await read(candidate);
      if (!text) continue;
      const hit = text.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*(-?[\\d.]+)\\b`));
      if (hit) {
        const n = Number(hit[1]);
        if (Number.isFinite(n)) return n;
      }
    }
  }

  return null;
}

/**
 * Can a boundary probe actually observe this comparison?
 *
 * This is the question that decides whether we may write a test at all.
 *
 * For `isFull(count) { return count >= MAX; }` the comparison IS the return value,
 * so calling at 9/10/11 shows the flip immediately.
 *
 * For `const visible = threat.distance <= sight; if (visible && wounded) return
 * 'flee';` the comparison feeds an intermediate variable that many branches
 * consume. Probing 14/15/16 returned 'wander' three times because the real
 * difference only appears when other conditions also hold. Writing a test from
 * that probe would pin three identical values and catch nothing.
 *
 * So we only auto-fix the observable case. The rest is reported for a human.
 */
export function isDirectlyObservable({ comparison, source, fnName }) {
  // Find the function body.
  const fnStart = source.search(new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${fnName}\\s*\\(|(?:export\\s+)?const\\s+${fnName}\\s*=`));
  if (fnStart === -1) return false;

  const body = source.slice(fnStart, fnStart + 4000);
  const expr = `${comparison.left} ${comparison.op} ${comparison.right}`;

  // Case 1: the comparison is returned directly.
  if (new RegExp(`return\\s+${escapeRe(expr)}`).test(body)) return true;

  // Case 2: the comparison is assigned to a name that is immediately returned.
  const assigned = body.match(new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*[^;]*${escapeRe(comparison.op)}\\s*[^;]*;`));
  if (assigned) {
    const varName = assigned[1];
    if (new RegExp(`return\\s+${varName}\\s*;`).test(body)) return true;
  }

  return false;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
export async function fixObjectBoundary({ root, sourceFile, testFiles, fn, comparison, source, runner, runnerName }) {
  // Only comparisons that actually flip at equality are worth a boundary test.
  if (!['>=', '<=', '>', '<'].includes(comparison.op)) {
    return { written: null, cases: 0, reason: 'not a threshold comparison' };
  }

  // Only fix what a probe can actually observe. See isDirectlyObservable.
  if (!isDirectlyObservable({ comparison, source, fnName: fn })) {
    return {
      written: null,
      cases: 0,
      reason: `the comparison feeds other logic, so a boundary call alone would not show the difference — needs a hand-written case`,
    };
  }

  let testSource = '';
  for (const tf of testFiles) {
    try { testSource += await readFile(tf, 'utf8') + '\n'; } catch { /* ignore */ }
  }

  const literals = harvestObjectLiterals(testSource);

  let threshold = thresholdOf({ comparison, source, literals });
  if (threshold === null) {
    // Follow imports: `size >= MAX_SIZE` where MAX_SIZE lives in another module.
    const fs = await import('node:fs/promises');
    threshold = await resolveConstantDeep({
      name: comparison.right,
      source,
      file: sourceFile,
      read: async (p) => {
        try { return await fs.readFile(p, 'utf8'); } catch { return null; }
      },
    });
  }

  if (threshold === null) {
    return { written: null, cases: 0, reason: `could not resolve ${comparison.right} to a number` };
  }

  const carrier = chooseCarrier({ comparison, literals });

  if (!carrier) {
    return {
      written: null,
      cases: 0,
      reason: `no test object carries the field ${ownerField(comparison.left)}`,
    };
  }

  const points = [threshold - 1, threshold, threshold + 1];

  // For the nested case the operand is a field of the nested object
  // (`threat.distance`), so the override must reproduce that inner field.
  // For the direct case the operand is a plain field (`state.count` → `count`).
  const path = comparison.left.split('.').map((s) => s.trim()).filter(Boolean);
  const innerField = carrier.kind === 'nested' && path.length > 1 ? path[path.length - 1] : null;

  const nestedValue = (v) => (innerField
    ? `{ id: 'crucible', ${innerField}: ${v} }`
    : String(v));

  const { fixPath, importPath, dir, probeName } = placement({ sourceFile, testFiles, root });

  // The probe must not be discoverable as a test: a project whose runner globs
  // `test/*.test.js` would pick it up and run it with the whole suite.
  const probeFile = probeName.replace(/\.test\.(m?[jt]s)$/, '.probe.$1');
  const probePath = join(dir, probeFile);

  try {
    const probeBody = buildObjectProbe({
      importPath,
      fn,
      baseName: carrier.base,
      baseText: carrier.literal.text,
      kind: carrier.kind,
      field: carrier.field,
      points,
      nestedValue,
      runner,
    });
    await writeFile(probePath, probeBody, 'utf8');

    // Run ONLY the probe file, never the whole suite: the suite can take minutes
    // on a real project and the probe does not need it.
    //
    // Two strategies, because module resolution differs:
    //   - plain JS: `node probe.mjs` resolves relative imports directly
    //   - TypeScript: the project's runner is the only thing that understands the
    //     extensions, so we ask it for just this file
    let probed = null;

    const plainJs = /\.(js|mjs|cjs)$/.test(sourceFile);
    if (plainJs) {
      const fileRun = await run(`node ${JSON.stringify(probePath)}`, root, 30_000);
      probed = parseProbeOutput(fileRun.stdout + fileRun.stderr);
    }

    if (!probed) {
      // Target only the probe file. The exact syntax differs per runner.
      const onlyThis = runner.includes('vitest')
        ? `npx --no-install vitest run ${JSON.stringify(probeName)}`
        : runner.includes('jest')
          ? `npx --no-install jest ${JSON.stringify(probeName)}`
          : `node --test ${JSON.stringify(probeName)}`;

      const runnerRun = await run(onlyThis, dir, 60_000);
      probed = parseProbeOutput(runnerRun.stdout + runnerRun.stderr);
    }

    if (!probed || probed.length === 0) {
      return { written: null, cases: 0, reason: 'probe produced no values' };
    }

    const observed = probed.map((p) => (p.error ? undefined : p.value));
    if (observed.every((v) => v === undefined)) {
      return { written: null, cases: 0, reason: 'every boundary call threw' };
    }

    // If all three boundary points return the same thing, the test pins nothing:
    // the comparison's effect is invisible at this call site. Refuse to write it
    // rather than ship a green test that cannot fail.
    const distinct = new Set(observed.map((v) => JSON.stringify(v)));
    if (distinct.size < 2) {
      return {
        written: null,
        cases: 0,
        reason: 'all three boundary points return the same value, so a test here would catch nothing',
      };
    }

    const body = buildObjectTest({
      importPath,
      fn,
      sourceName: sourceFile.split('/').pop().replace(/\.[^.]+$/, ''),
      runner,
      baseText: carrier.literal.text,
      kind: carrier.kind,
      field: carrier.field,
      points,
      nestedValue,
      observed,
      comparison,
    });

    await writeFile(fixPath, body, 'utf8');
    return { written: fixPath, cases: 1 };
  } finally {
    await rm(probePath, { force: true });
  }
}
