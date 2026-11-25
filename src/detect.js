/**
 * Static detectors for tests that cannot fail.
 *
 * Mutation testing answers "does this suite notice a break?" but it cannot tell
 * a fake test from a property test. A noise function asserted for range and
 * continuity is a good test that legitimately survives a constant tweak.
 *
 * These detectors find the unambiguous cases: assertions that are true by
 * construction. They are the high-confidence half of the report, and the reason
 * the tool is trustworthy — every one of them is provable by reading one line.
 */

/** @typedef {{ id: string, file: string, line: number, kind: string, snippet: string, why: string, fix: string }} Finding */

const PATTERNS = [
  {
    id: 'always-true',
    kind: 'tautology',
    // expect(true).toBe(true) / assertTrue(True) / expect(1).toBe(1)
    re: /expect\s*\(\s*(true|false|\d+)\s*\)\s*\.\s*(toBe|toEqual|toStrictEqual)\s*\(\s*(true|false|\d+)\s*\)/,
    why: 'compares two literals; this assertion is true no matter what the code does',
    fix: 'assert on the value the function actually returns',
  },
  {
    id: 'assert-true-literal',
    kind: 'tautology',
    re: /assert\s*\(\s*true\s*\)|assertTrue\s*\(\s*True\s*\)/,
    why: 'asserts a literal true',
    fix: 'assert a real condition from the code under test',
  },
  {
    id: 'not-null-only',
    kind: 'weak',
    // expect(x).toBeDefined() as the ONLY assertion is weak but legal; flagged separately.
    re: /expect\s*\(\s*[^)]+\)\s*\.\s*(toBeDefined|not\s*\.\s*toBeNull)\s*\(\s*\)\s*;?\s*$/,
    why: 'only checks the value exists, never what it is',
    fix: 'assert the concrete value or shape',
  },
  {
    id: 'type-only',
    kind: 'weak',
    needsStrings: true,
    // expect(typeof x).toBe('number') / assert.equal(typeof x, 'string')
    // Asserts the type, never the value. Passes for every wrong number.
    // The subject may be a call, so parentheses inside it must be allowed.
    re: /(?:expect\s*\(\s*typeof\s+.+?\)\s*\.\s*(?:toBe|toEqual)\s*\(\s*['"][^'"]+['"]\s*\)|assert\.\w+\s*\(\s*typeof\s+.+?,\s*['"][^'"]+['"]\s*\))/,
    why: 'checks only the type, so any value of that type passes, including a wrong one',
    fix: 'assert the exact value',
  },
  {
    id: 'truthy-only',
    kind: 'weak',
    re: /expect\s*\(\s*[^)]+\)\s*\.\s*toBeTruthy\s*\(\s*\)/,
    why: 'accepts any truthy value, including wrong ones',
    fix: 'assert the exact value',
  },
  {
    id: 'no-assertion',
    kind: 'empty',
    // A test body with no expect/assert at all is handled separately below.
    re: null,
    why: 'test body contains no assertion',
    fix: 'add an assertion, or delete the test',
  },
  {
    id: 'empty-catch-in-test',
    kind: 'swallow',
    re: /catch\s*(\([^)]*\))?\s*\{\s*\}/,
    why: 'swallows the error, so the test passes even when the call throws',
    fix: 'let the error fail the test, or assert on the message',
  },
  {
    id: 'expect-in-callback-not-awaited',
    kind: 'async',
    re: /expect\s*\([^)]*\)\s*\.\s*rejects/,
    why: 'rejects/throws needs await; without it the assertion never runs',
    fix: 'prefix with await',
  },
  {
    id: 'skipped',
    kind: 'skipped',
    re: /\b(it|test|describe)\s*\.\s*(skip|todo)\s*\(/,
    why: 'test is skipped, so it can never catch a regression',
    fix: 'fix and re-enable, or delete it',
  },
];

/**
 * Extract test blocks with their bodies so we can look for missing assertions.
 * Handles `it('...', () => { ... })` and `it('...', function () { ... })`.
 * @returns {{ line: number, name: string, body: string, startLine: number }[]}
 */
function testBlocks(source) {
  const blocks = [];
  const lines = source.split('\n');
  const re = /\b(it|test)\s*\(\s*(['"`])((?:\\.|(?!\2).)*)\2/g;

  let m;
  while ((m = re.exec(source)) !== null) {
    const startIdx = m.index;
    const line = source.slice(0, startIdx).split('\n').length;

    // Find the opening brace of the callback after the name.
    const afterName = source.indexOf(m[0].length + startIdx);
    let braceIdx = -1;
    for (let i = startIdx + m[0].length; i < source.length; i += 1) {
      if (source[i] === '{') { braceIdx = i; break; }
      if (source[i] === ')' && source[i - 1] !== '(') break;
    }
    if (braceIdx === -1) continue;

    let depth = 0;
    let end = -1;
    for (let i = braceIdx; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) continue;

    blocks.push({
      line,
      startLine: line,
      name: m[3],
      body: source.slice(braceIdx, end + 1),
    });
  }

  return blocks;
}

/**
 * Mask string and template literal contents before pattern matching, so sample
 * code inside a test fixture (e.g. a linter testing itself) is not mistaken for
 * real assertions.
 *
 * This matters more than it looks: the first project anyone points unfake at might
 * well be a tool that tests tools, and reporting its fixtures as fake tests would
 * destroy trust immediately.
 */
function maskStrings(source) {
  let out = '';
  let i = 0;
  let quote = null;

  while (i < source.length) {
    const ch = source[i];

    if (quote) {
      if (ch === '\\') {
        out += '  ';
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
        out += ' ';
        i += 1;
        continue;
      }
      // Keep newlines so line numbers stay aligned.
      out += ch === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ' ';
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * A file can opt out of one or all checks with a comment, because a tool that tests
 * tools legitimately contains sample code that looks broken.
 *
 *   // unfake-ignore-file        skip this file entirely
 *   // unfake-ignore mock-self   skip one finding id
 */
export function ignoreDirectives(source) {
  const all = /\/\/\s*unfake-ignore-file/.test(source);
  const ids = new Set();
  const re = /\/\/\s*unfake-ignore\s+([\w-]+)/g;
  let m;
  while ((m = re.exec(source)) !== null) ids.add(m[1]);
  return { all, ids };
}

/**
 * Scan a test file for findings.
 *
 * @param {string} source
 * @param {string} fileLabel
 * @param {{ mask?: boolean }} [options]  mask=false when the caller passes a code
 *   fragment that is itself a fixture (a detector testing a detector).
 * @returns {Finding[]}
 */
export function scanTestSource(source, fileLabel, options = {}) {
  const ignore = ignoreDirectives(source);
  if (ignore.all) return [];

  const useMask = options.mask !== false;
  const findings = [];
  const lines = source.split('\n');
  const maskedSource = useMask ? maskStrings(source) : source;
  const maskedLines = maskedSource.split('\n');

  // Line-level pattern hits, matched against the masked text so sample code inside
  // string literals is ignored. Type-only assertions need the real text, because
  // the type name lives inside a string literal.
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const masked = maskedLines[i] ?? '';
    if (!line.trim()) continue;

    for (const p of PATTERNS) {
      if (!p.re) continue;
      const haystack = p.needsStrings ? line : masked;
      if (!p.re.test(haystack)) continue;
      findings.push({
        id: p.id,
        file: fileLabel,
        line: i + 1,
        kind: p.kind,
        snippet: line.trim().slice(0, 120),
        why: p.why,
        fix: p.fix,
      });
    }
  }

  // Block-level: a test with no assertion at all. Uses the masked source so a
  // fixture that merely contains the word "expect" inside a string is not counted.
  for (const block of testBlocks(maskedSource)) {
    const hasAssert = /\b(expect|assert|should)\b/.test(block.body);
    const hasThrow = /\bthrow\b/.test(block.body);
    const isSkipped = /\.\s*(skip|todo)\s*\(/.test(maskedLines[block.startLine - 1] ?? '');

    // An empty catch is already reported at line level with a clearer reason;
    // do not double-report the same test.
    const alreadyReported = findings.some(
      (f) => f.line >= block.startLine && f.line <= block.startLine + block.body.split('\n').length,
    );

    if (!hasAssert && !hasThrow && !isSkipped && !alreadyReported) {
      // Recover the original name text from the real source.
      const originalName = (lines[block.startLine - 1] ?? '').match(/(['"`])((?:\\.|(?!\1).)*)\1/)?.[2] ?? block.name;
      findings.push({
        id: 'no-assertion',
        file: fileLabel,
        line: block.startLine,
        kind: 'empty',
        snippet: `it('${originalName}')`,
        why: 'test runs code but never asserts anything, so it passes even if the code is wrong',
        fix: 'assert on the result, or delete the test',
      });
    }
  }

  // Mocking the thing under test makes the test self-fulfilling.
  //
  // This needs the real text, because the module paths are inside quotes and the
  // masked copy has them blanked. We check that the mocked path and the imported
  // path are the same string, which is what makes the test assert its own mock.
  const mockCall = /vi\.mock\s*\(\s*['"]([^'"]+)['"]/g;
  let mockMatch;
  while ((mockMatch = mockCall.exec(source)) !== null) {
    const mockedPath = mockMatch[1];
    const tail = source.slice(mockMatch.index, mockMatch.index + 600);
    const importRe = new RegExp(`import\\s[^;]*from\\s*['"]${mockedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);

    if (importRe.test(tail)) {
      findings.push({
        id: 'mock-self',
        file: fileLabel,
        line: source.slice(0, mockMatch.index).split('\n').length,
        kind: 'self-fulfilling',
        snippet: `vi.mock('${mockedPath}') on the module the test imports`,
        why: 'the test replaces the module it is testing, so it asserts the mock, not the code',
        fix: 'mock collaborators, not the unit under test',
      });
      break;
    }
  }

  return findings.filter((f) => !ignore.ids.has(f.id));
}

/**
 * Count real assertions in a file, for the summary line.
 */
export function assertionCount(source) {
  const matches = source.match(/\b(expect\s*\(|assert\w*\s*\()/g);
  return matches ? matches.length : 0;
}
