/**
 * Confidence model.
 *
 * The whole product lives or dies on one question: when we say "this test is
 * fake", is it true? A property test on a noise function legitimately survives a
 * constant tweak, and calling that fake would be a lie that destroys trust on the
 * first real repo anyone points us at.
 *
 * So we grade every signal:
 *
 *   CERTAIN   provable by reading one line (tautology, no assertion, empty catch,
 *             mock of the unit under test, skipped test)
 *   LIKELY    a mutation survived AND the test file has no assertion that could
 *             have caught it (no exact-value assertions anywhere)
 *   SUSPECT   a mutation survived but the test does assert real behaviour; this
 *             may be a property test or a genuine gap — we say so, we do not claim
 *
 * Only CERTAIN and LIKELY drive the headline number. SUSPECT is listed separately
 * and never counted as a fake test.
 */

export const CONFIDENCE = {
  CERTAIN: 'certain',
  LIKELY: 'likely',
  SUSPECT: 'suspect',
};

/** Finding ids that are provable by inspection, no execution needed. */
const CERTAIN_IDS = new Set([
  'always-true',
  'assert-true-literal',
  'no-assertion',
  'mock-self',
  'expect-in-callback-not-awaited',
]);

/** Finding ids that are real smells but legal in context. */
const SUSPECT_IDS = new Set([
  'not-null-only',
  'truthy-only',
  'type-only',
  // A skipped test cannot fail, but real projects skip integration tests when an
  // external service is unavailable. That is not evidence of a fake test and must
  // not drive the CI exit code.
  'skipped',
  // An empty catch inside a test file is often deliberate: a feature probe, an
  // optional cleanup, a tolerant resolution like lodash's
  // `try { realpathSync(p) } catch {}`. It only matters on the assertion path, and
  // no static rule can tell which is which. lodash has 45 of these; calling all of
  // them defects would destroy the report's credibility.
  'empty-catch-in-test',
]);

export function gradeFinding(finding) {
  // A test that runs several statements but asserts nothing is not provably fake: it
  // may be a smoke test that fails when the code throws. Keep it in the report, out
  // of the certain count.
  if (finding.id === 'no-assertion' && (finding.thin || finding.smoke)) {
    return CONFIDENCE.SUSPECT;
  }

  if (CERTAIN_IDS.has(finding.id)) return CONFIDENCE.CERTAIN;
  if (SUSPECT_IDS.has(finding.id)) return CONFIDENCE.SUSPECT;
  return CONFIDENCE.SUSPECT;
}

/**
 * Does this test file contain any assertion that pins a concrete value?
 * `toBe(1)`, `toEqual({...})`, `toBeCloseTo(3.2)` pin values.
 * `toBeGreaterThan`, `toBeTruthy`, `toBeDefined` do not.
 */
export function hasValuePinningAssertions(testSource) {
  // A literal operand, including an object or array literal: `deepStrictEqual(x,
  // { count: 3 })` pins just as surely as `equal(x, 3)`.
  const literal = String.raw`(?:-?[\d.]+|'[^']*'|"[^"]*"|true|false|null|\{[^}]*\}|\[[^\]]*\])`;

  const matcher = /\.\s*(toBe|toEqual|toStrictEqual|toBeCloseTo|toMatchObject|toMatchInlineSnapshot)\s*\(/;
  const matcherLiteral = new RegExp(String.raw`\.\s*(?:toBe|toEqual|toStrictEqual|toBeCloseTo)\s*\(\s*${literal}\s*[,)]`);

  // Every dialect pins values in its own spelling. Recognising only jest/vitest
  // matchers labelled every surviving mutation in a node:test, ava or pytest
  // project "likely" — overclaiming exactly the way this tool must not.
  const avaLiteral = new RegExp(String.raw`\bt\s*\.\s*(?:is|not|deepEqual|like)\s*\(\s*[^,]+,\s*${literal}\s*[,)]`);
  const nodeAssertLiteral = new RegExp(String.raw`\bassert\s*\.\s*(?:equal|strictEqual|deepEqual|deepStrictEqual|notEqual|notStrictEqual)\s*\(\s*[^,]+,\s*${literal}\s*[,)]`);
  const pythonLiteral = /^\s*assert\s+.+?(?:==|!=|\bis\b)\s*(?:-?[\d.]+|'[^']*'|"[^"]*"|True|False|None)\s*$/m;

  if (matcher.test(testSource) && matcherLiteral.test(testSource)) return true;
  return avaLiteral.test(testSource)
    || nodeAssertLiteral.test(testSource)
    || pythonLiteral.test(testSource);
}

/**
 * Grade a surviving mutation given what the covering tests look like.
 * @param {object} opts
 * @param {string} opts.testSource   concatenated source of covering tests
 * @param {boolean} opts.hasTest     whether any test covers this file at all
 */
export function gradeSurvivor({ testSource, hasTest }) {
  if (!hasTest) {
    return {
      confidence: 'untested',
      why: 'no test references this file, so nothing covers it',
    };
  }

  if (!hasValuePinningAssertions(testSource)) {
    return {
      confidence: CONFIDENCE.LIKELY,
      why: 'tests only compare direction or truthiness; no assertion pins a value, so a changed constant is invisible',
    };
  }

  return {
    confidence: CONFIDENCE.SUSPECT,
    why: 'tests do pin some values, so this may be a deliberate property test or an uncovered branch',
  };
}

/** Headline metric: only what we can defend. */
export function headline(findings) {
  const certain = findings.filter((f) => f.confidence === CONFIDENCE.CERTAIN);
  const likely = findings.filter((f) => f.confidence === CONFIDENCE.LIKELY);
  const suspect = findings.filter((f) => f.confidence === CONFIDENCE.SUSPECT);

  return {
    fakeTests: certain.length,
    likelyFake: likely.length,
    worthChecking: suspect.length,
  };
}
