/**
 * Boundary analysis: the strongest signal this tool has.
 *
 * A `<` flipped to `<=` surviving means no test exercises the exact boundary
 * (distance === sightRange). That is not a stylistic complaint — it is a concrete,
 * high-probability bug class. Off-by-one at a threshold is one of the most common
 * real defects in game logic, pagination, retries and permission checks.
 *
 * This module decides whether a surviving mutation sits on a boundary, which is
 * what lets the report say "this specific comparison is untested at its edge"
 * instead of the useless "your tests are weak".
 */

import { NEIGHBOUR_OPERATOR } from './paths.js';


/** Comparison operators and what their boundary is. */
const COMPARISONS = new Set(['===', '!==', '==', '!=', '>=', '<=', '>', '<']);

/**
 * Loop counters are not business boundaries. Flipping `i < 512` in a `for` loop
 * is usually equivalent or trivially covered; reporting it as an untested edge
 * would be noise.
 */
export function isLoopBoundary(mutation, sourceLines) {
  const line = sourceLines[mutation.line - 1] ?? '';
  if (/\bfor\s*\(/.test(line)) return true;
  // A comparison whose left side is a bare single-letter counter.
  if (/\b[a-z]\s*[<>]=?/.test(line) && /\b(while|for)\b/.test(line)) return true;
  return false;
}

/**
 * A boundary mutation is one where a comparison operator changed.
 *
 * Numeric literal bumps are deliberately NOT boundaries. Bumping a config
 * constant (`surviveTick: 0`, `new Uint8Array(256)`) usually produces an
 * equivalent mutant: the value is not a threshold, so no test should pin it.
 * Reporting those as defects is how a tool loses all credibility.
 *
 * A numeric bump only matters when it is a threshold, and we detect that
 * separately by looking at whether the literal sits inside a comparison.
 */
export function isBoundaryMutation(mutation, sourceLines = []) {
  if (mutation.kind !== 'comparison') return false;
  if (!COMPARISONS.has(mutation.original)) return false;
  if (isLoopBoundary(mutation, sourceLines)) return false;
  return true;
}

/**
 * A numeric literal is a threshold only when it sits in a real comparison.
 *
 * This has to be strict. `t | 1` in a hash and `Math.imul(...)` are bit tricks,
 * not thresholds; bumping them is an equivalent mutant and reporting it as a
 * defect is noise. We require a comparison operator on the line AND the literal to
 * be one of the compared operands.
 */
export function isThresholdLiteral(mutation, sourceLines) {
  if (mutation.kind !== 'number') return false;
  const line = sourceLines[mutation.line - 1] ?? '';
  if (/\b(for|while)\s*\(/.test(line)) return false;
  if (/[|&^~]/.test(line)) return false; // bitwise tricks, not thresholds
  if (/>>|<<|>>>/.test(line)) return false; // shifts are not thresholds

  // The literal must be adjacent to a comparison operator.
  const lit = mutation.original.replace('.', '\\.');
  const re = new RegExp(`(?:[<>]=?|===?|!==?)\\s*${lit}\\b|\\b${lit}\\s*(?:[<>]=?|===?|!==?)`);
  return re.test(line);
}

/**
 * Extract the surrounding expression so the report can show what is untested,
 * e.g. `threat.distance <= p.sightRange` rather than just `<=`.
 *
 * `mutation.column` (1-based) pins the exact operator occurrence; without it, a
 * line like `if (count >= MAX && weight >= 5)` produced the SAME description for
 * both survivors, and the location dedup collapsed them into one finding.
 */
export function describeBoundary(mutation, sourceLines) {
  const line = sourceLines[mutation.line - 1] ?? '';
  const trimmed = line.trim();

  if (mutation.kind === 'comparison') {
    // Prefer the column the mutation was generated from; fall back to the first
    // occurrence for callers that hand-build a mutation object (older tests).
    let idx = typeof mutation.column === 'number' ? mutation.column - 1 : -1;
    if (idx === -1 || line.slice(idx, idx + mutation.original.length) !== mutation.original) {
      idx = line.indexOf(mutation.original, Math.max(0, line.indexOf(trimmed)));
    }
    if (idx !== -1) {
      const before = line.slice(0, idx);
      const after = line.slice(idx + mutation.original.length);
      // A negative number is a valid right operand: `a > -1` must describe as
      // `a > -1`, not fall back to the whole line.
      const left = (before.match(/[\w.$\[\]'"]+(?:\([^)]*\))?\s*$/) ?? [''])[0].trim();
      const right = (after.match(/^\s*-?[\w.$\[\]'"]+(?:\([^)]*\))?/) ?? [''])[0].trim();
      if (left && right) return `${left} ${mutation.original} ${right}`;
    }
  }

  if (mutation.kind === 'number') {
    // Show the comparison this threshold belongs to, not the whole line.
    const re = new RegExp(`([\\w.$\\[\\]'"]+\\s*(?:[<>]=?|===?|!==?)\\s*${mutation.original.replace('.', '\\.')}\\b|\\b${mutation.original.replace('.', '\\.')}\\s*(?:[<>]=?|===?|!==?)\\s*[\\w.$\\[\\]'"]+)`);
    const m = line.match(re);
    if (m) return m[1];
  }

  return trimmed.slice(0, 100);
}

/**
 * The test a human should write for this boundary.
 * Concrete and copy-pasteable, because "improve your tests" helps nobody.
 */
export function suggestBoundaryTest(mutation, described) {
  if (mutation.kind === 'comparison') {
    const eq = NEIGHBOUR_OPERATOR[mutation.original];
    return `Add a case where both sides are equal: the ${mutation.original} and ${eq} versions differ only at that point.`;
  }

  if (mutation.kind === 'number') {
    return `Assert the exact value this expression produces, so a changed constant fails the suite.`;
  }

  return 'Cover this branch directly.';
}

/**
 * Rank survivors: comparison boundaries first, then threshold literals, then the
 * rest. Only the first two groups are reported as actionable edges.
 */
export function rankSurvivors(survivors, sourceLines) {
  return survivors
    .map((s) => {
      const boundary = isBoundaryMutation(s.mutation, sourceLines);
      const threshold = !boundary && isThresholdLiteral(s.mutation, sourceLines);
      return {
        ...s,
        boundary,
        threshold,
        described: describeBoundary(s.mutation, sourceLines),
        suggestion: boundary || threshold
          ? suggestBoundaryTest(s.mutation, null)
          : null,
        weight: boundary ? 2 : threshold ? 1 : 0,
      };
    })
    .sort((a, b) => b.weight - a.weight);
}
