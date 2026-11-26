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
    // `.rejects` / `.resolves` return a promise. Without `await`, `return`, or an
    // arrow-function implicit return, the assertion never runs and the test passes
    // regardless.
    //
    // Both exemptions matter: axios has `await expect(x).rejects...` and also
    // `const guard = (p) => expect(p).rejects...`, where the arrow returns the
    // promise and the caller awaits it. Flagging either would be a false positive
    // on well-written async tests, which is the fastest way to lose a user.
    re: /(?<!await\s)(?<!return\s)(?<!=>\s)(?<!=>\s\s)\bexpect\s*\([^)]*\)\s*\.\s*(?:rejects|resolves)\b/,
    why: 'rejects/resolves returns a promise; without await the assertion never runs',
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
export function testBlocks(source) {
  const blocks = [];
  const lines = source.split('\n');
  const re = /\b(it|test)\s*\(\s*(['"`])((?:\\.|(?!\2).)*)\2/g;

  let m;
  while ((m = re.exec(source)) !== null) {
    const startIdx = m.index;
    const line = source.slice(0, startIdx).split('\n').length;

    // Find the callback's opening brace, not the first brace in the line.
    //
    // A test can take options before the callback:
    //   it('name', { retry: 2 }, async () => {...})
    // Taking the first `{` grabbed `{ retry: 2 }` as the body, so every assertion
    // inside the real callback was invisible.
    //
    // The reliable signals are `=>` (arrow) and `function`. Prefer whichever comes
    // first after the name; fall back to the old scan when neither is present.
    let braceIdx = -1;
    const afterName = startIdx + m[0].length;
    const head = source.slice(afterName, afterName + 2000);
    const arrow = head.indexOf('=>');
    const fnKeyword = head.indexOf('function');
    const marker = arrow !== -1 && (fnKeyword === -1 || arrow < fnKeyword) ? arrow
      : fnKeyword !== -1 ? fnKeyword : -1;

    if (marker !== -1) {
      for (let i = afterName + marker; i < source.length; i += 1) {
        if (source[i] === '{') { braceIdx = i; break; }
        if (source[i] === ';') break;
      }
    }

    if (braceIdx === -1) {
      for (let i = afterName; i < source.length; i += 1) {
        if (source[i] === '{') { braceIdx = i; break; }
        if (source[i] === ')' && source[i - 1] !== '(') break;
      }
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
 * Strip string literals so pattern matching does not trip over prose.
 *
 * Returns a string of identical length where masked characters become spaces, so
 * every index maps to the same index in the original.
 *
 * IMPORTANT: this walks the whole source, not one line. When it meets `//` it must
 * skip to the end of that line and carry on — an earlier version used `break`,
 * which silently discarded the rest of the file. That made every assertion after
 * the first line comment invisible, and axios's test files are full of comments.
 */
function maskStrings(source) {
  let out = '';
  let i = 0;
  let quote = null;
  let inBlockComment = false;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        out += '  ';
        i += 2;
        continue;
      }
      out += ch === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }

    if (quote) {
      if (ch === '\\') {
        out += ch === '\\' ? ' ' : ' ';
        out += next === '\n' ? '\n' : ' ';
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
        out += ch;
        i += 1;
        continue;
      }
      out += ch === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }

    // Line comment: blank it out up to the newline, then keep going.
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      out += '  ';
      i += 2;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      // Keep the delimiters, blank the contents. testBlocks needs to see `it('x'`
      // to find a test, and a fully blanked string made every test invisible — but
      // keeping the whole literal made code inside a template string look like real
      // code. Blanking only the contents satisfies both.
      quote = ch;
      out += ch;
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
 *   // crucible-ignore-file        skip this file entirely
 *   // crucible-ignore mock-self   skip one finding id
 */
export function ignoreDirectives(source) {
  const all = /\/\/\s*crucible-ignore-file/.test(source);
  const ids = new Set();
  const re = /\/\/\s*crucible-ignore\s+([\w-]+)/g;
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

  // Helpers defined in this file. A test that calls one of them may well be
  // asserting inside it — axios has `testHeaderValue(request, key, value)` at the
  // top of headers.browser.test.js and calls it from 54 tests, none of which contain
  // a literal `expect`. Reporting those as "no assertion" is the kind of false
  // positive that gets a tool uninstalled.
  //
  // We cannot resolve cross-file helpers without an import graph, so this is a
  // deliberately generous rule: doubt means silence, not an accusation.
  const localHelpers = new Set();
  for (const re of [/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/g]) {
    let m;
    while ((m = re.exec(maskedSource)) !== null) localHelpers.add(m[1]);
  }

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

      // A promise assertion on its own line is fine when the previous line opens an
      // arrow body: `const guard = (p) =>` / `= async (p) =>`. That form returns the
      // promise and the caller awaits it.
      if (p.id === 'expect-in-callback-not-awaited') {
        const prev = (maskedLines[i - 1] ?? '').trimEnd();
        if (/=>$/.test(prev) || /=>\s*$/.test(prev)) continue;
      }

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

  // Block-level: a test with no assertion at all.
  //
  // testBlocks must run on the ORIGINAL source: it matches `it('name', ...)`, and
  // maskStrings blanks the quotes, which silently disabled every block-level check.
  // The body is then re-masked so an `expect` inside a string does not count as an
  // assertion.
  for (const block of testBlocks(maskedSource)) {
    const maskedBody = maskStrings(block.body);

    // Assertion dialects differ by framework:
    //   vitest/jest  expect(x).toBe(y)
    //   node:test    assert.equal(x, y)
    //   ava / tap    t.true(x), t.is(x, y), t.deepEqual(...)
    //   qunit        assert.ok(x)
    //   deno         assertEquals(x, y) from @std/assert
    // Missing the `t` form reported 282 "no assertion" findings on p-map, every one
    // of them a well-written ava test. The trailing `\w*` covers assertEquals,
    // assertThrows, assertNotEquals and friends.
    const hasAssert = /\b(?:expect|assert\w*|should)\b/.test(maskedBody)
      || /\bt\s*\.\s*(?:true|false|is|not|deepEqual|notDeepEqual|like|throws|throwsAsync|notThrows|snapshot|regex|pass|fail|ok|equal|same|plan|end|timeout)\s*\(/.test(maskedBody);

    const hasThrow = /\bthrow\b/.test(maskedBody);
    // A `try` without a swallowing catch is itself an assertion: if the call inside
    // fails, the test fails. axios has tests that only run a command and clean up.
    const hasTry = /\btry\s*\{/.test(maskedBody);

    // Callback-style tests (mocha, jest): `function(done)` or `(done) =>`. Success is
    // reported by calling done(), failure by done(err) or by throwing. express has
    // seven of these, all legitimate.
    const headLine = lines[block.startLine - 1] ?? '';
    const hasDoneCallback = /\b(function\s*)?\(\s*(done|next)\s*\)/.test(headLine)
      || /async\s*\(\s*(done|next)\s*\)/.test(headLine);
    const callsDone = /\bdone\s*\(/.test(maskedBody);

    const isSkipped = /\.\s*(skip|todo)\s*\(/.test(maskedLines[block.startLine - 1] ?? '');

    // Calling a helper defined in this file counts as possible assertion.
    const callsLocalHelper = [...localHelpers].some(
      (name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`).test(maskedBody),
    );

    // An empty catch is already reported at line level with a clearer reason;
    // do not double-report the same test.
    const alreadyReported = findings.some(
      (f) => f.line >= block.startLine && f.line <= block.startLine + block.body.split('\n').length,
    );

    if (!hasAssert && !hasThrow && !hasTry && !hasDoneCallback && !callsDone && !isSkipped && !alreadyReported && !callsLocalHelper) {
      // Recover the original name text from the real source.
      const originalName = (lines[block.startLine - 1] ?? '').match(/(['"`])((?:\\.|(?!\1).)*)\1/)?.[2] ?? block.name;
      // How much does this test actually do?
      //
      //   it('clamp runs', () => { clamp(5, 0, 10); })
      //     one bare call to something that cannot throw — passes forever
      //
      //   it('should not throw', () => {
      //     var router = new Router();
      //     router.route('/foo').all(fn).all(fn);
      //   })
      //     builds objects and chains calls; if any of that throws, the test fails
      //
      // Both have no assertion, but only the first can never catch anything. Counting
      // statements is a crude proxy and it is the honest one: the second stays in the
      // report as something to review, not as a proven defect.
      const statements = (maskedBody.match(/;/g) ?? []).length;
      const thin = statements > 1;

      findings.push({
        id: 'no-assertion',
        file: fileLabel,
        line: block.startLine,
        kind: 'empty',
        snippet: `it('${originalName}')`,
        why: thin
          ? 'test runs several statements but asserts nothing; it only fails if the code throws'
          : 'test calls code once and asserts nothing, so it passes even if the result is wrong',
        fix: 'assert on the result, or delete the test',
        thin,
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
