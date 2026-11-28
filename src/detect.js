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

import { parseJs, walk, isJsFile } from './js-ast.js';

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
    why: 'test is skipped, so it cannot currently catch a regression; it may be intentionally gated',
    fix: 're-enable when the dependency is available, or delete it',
  },
  {
    // pytest / unittest spell skipping as a decorator rather than a method call.
    id: 'skipped',
    kind: 'skipped',
    re: /@\s*(?:pytest\s*\.\s*mark\s*\.\s*(?:skip|skipif|xfail)|unittest\s*\.\s*skip)\b/,
    why: 'test is skipped, so it cannot currently catch a regression; it may be intentionally gated',
    fix: 're-enable when the dependency is available, or delete it',
  },
  {
    // Python's version of an empty catch: the call can throw and the test still passes.
    id: 'empty-catch-in-test',
    kind: 'swallow',
    re: /except\b[^:\n]*:\s*pass\b/,
    why: 'swallows the error, so the test passes even when the call throws',
    fix: 'let the error fail the test, or assert on it',
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

    // An expression-bodied arrow test:
    //   it('x', () => expectMarkupMismatch(<div prop={true} />));
    // The first `{` is JSX, not the callback body. Use the full call expression
    // so imported assertion helpers remain visible.
    if (marker === arrow && arrow !== -1) {
      let expressionStart = afterName + arrow + 2;
      while (/\s/.test(source[expressionStart] ?? '')) expressionStart += 1;
      if (source[expressionStart] !== '{') {
        const callOpen = startIdx + m[0].indexOf('(');
        let depth = 0;
        let callClose = -1;
        let quote = null;
        for (let i = callOpen; i < source.length; i += 1) {
          const ch = source[i];
          if (quote) {
            if (ch === '\\') { i += 1; continue; }
            if (ch === quote) quote = null;
            continue;
          }
          if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
          if (ch === '(') depth += 1;
          else if (ch === ')') {
            depth -= 1;
            if (depth === 0) { callClose = i; break; }
          }
        }
        if (callClose !== -1) {
          blocks.push({
            line,
            startLine: line,
            name: m[3],
            body: source.slice(expressionStart, callClose).trim(),
          });
          continue;
        }
      }
    }

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
 * Extract Python test function bodies (`def test_...`), using indentation.
 *
 * Without this, `crucible check` was effectively silent on pytest projects: every
 * static block rule looked for `it(...)` or `test(...)`, which Python does not use.
 *
 * @returns {{ line: number, startLine: number, name: string, body: string }[]}
 */
export function pythonTestBlocks(source) {
  const lines = source.split('\n');
  const blocks = [];
  const defRe = /^([ \t]*)(?:async[ \t]+)?def[ \t]+(test\w*)[ \t]*\([^)]*\)[ \t]*(?:->[^:]+)?:/;
  const classRe = /^([ \t]*)class[ \t]+(\w+)([^:]*):/;
  const anyDefRe = /^([ \t]*)(?:async[ \t]+)?def[ \t]+\w+/;
  const stack = []; // enclosing class/def scopes: { indent, kind }

  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    if (!text.trim() || /^\s*#/.test(text)) continue;

    const lineIndent = text.match(/^[ \t]*/)[0].length;
    while (stack.length > 0 && lineIndent <= stack[stack.length - 1].indent) stack.pop();

    const classMatch = text.match(classRe);
    if (classMatch) {
      // Pytest/Unittest collect top-level classes only. A class defined inside a
      // function is a local fixture/helper, not a test container. Django also has
      // mixin/helper classes with methods named test_func(); they do not inherit
      // from a TestCase and are not collected by the test runner.
      const parent = stack[stack.length - 1];
      const name = classMatch[2];
      const header = classMatch[3] ?? '';
      const isTestClass = /^Test\w*/.test(name)
        || /(?:Test|Tests|TestCase)$/.test(name)
        || /\b(?:TestCase|SimpleTestCase|TransactionTestCase|IsolatedAsyncioTestCase)\b/.test(header);
      stack.push({ indent: lineIndent, kind: 'class', collect: !parent && isTestClass });
      continue;
    }

    const defMatch = text.match(defRe);
    const genericDef = text.match(anyDefRe);
    if (defMatch) {
      // A nested `def test_...` can be a Flask route handler or a helper inside
      // another test. Pytest collects module-level functions and class methods,
      // never functions defined inside a function body.
      const parent = stack[stack.length - 1];
      if (!parent || (parent.kind === 'class' && parent.collect)) {
        let end = i;
        for (let j = i + 1; j < lines.length; j += 1) {
          if (lines[j].trim() === '') continue;
          const bodyIndent = lines[j].match(/^[ \t]*/)[0].length;
          if (bodyIndent <= lineIndent) break;
          end = j;
        }
        blocks.push({
          line: i + 1,
          startLine: i + 1,
          name: defMatch[2],
          body: lines.slice(i, end + 1).join('\n'),
          inClass: Boolean(parent && parent.kind === 'class'),
        });
      }
      stack.push({ indent: lineIndent, kind: 'def' });
      continue;
    }

    if (genericDef) stack.push({ indent: lineIndent, kind: 'def' });
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
/**
 * Python-aware masking. The JS masker treats `"""..."""` as three independent
 * strings and has no `#` comments, so a docstring could desynchronise the entire
 * rest of a Django test file.
 */
export function maskPython(source) {
  // split('') keeps UTF-16 code units, matching source indices. Array.from()
  // collapses astral characters (emoji) into one entry and desynchronises every
  // later index, which shifted Django findings by 100 lines.
  const out = source.split('');
  const blank = (index) => { if (source[index] !== '\n') out[index] = ' '; };
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') { blank(i); i += 1; }
      continue;
    }
    if (ch !== '"' && ch !== "'") { i += 1; continue; }

    const triple = source.startsWith(ch.repeat(3), i);
    const delimiter = triple ? ch.repeat(3) : ch;
    blank(i);
    i += delimiter.length;
    while (i < source.length) {
      if (source[i] === '\\') {
        blank(i); blank(i + 1); i += 2;
        continue;
      }
      if (!triple && source[i] === '\n') break;
      if (source.startsWith(delimiter, i)) {
        for (let j = 0; j < delimiter.length; j += 1) blank(i + j);
        i += delimiter.length;
        break;
      }
      blank(i); i += 1;
    }
  }

  return out.join('');
}

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
  const pythonFile = /\.py$/i.test(fileLabel);
  const maskedSource = useMask
    ? (pythonFile ? maskPython(source) : maskStrings(source))
    : source;
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
  for (const re of [
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/g,
    // Helpers assigned in beforeEach/outer scopes: `mountComponent = async function`
    // or `mountComponent = async props =>`.
    /^[ \t]*([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function|[A-Za-z_$][\w$]*\s*=>)/gm,
    // Python helper functions and decorators defined in the same file.
    /^[ \t]*def[ \t]+([A-Za-z_]\w*)[ \t]*\(/gm,
  ]) {
    let m;
    while ((m = re.exec(maskedSource)) !== null) localHelpers.add(m[1]);
  }
  // Aliases of helpers: `const checkNoWarn = baseCheckWarn.bind(null, false)`
  // calls the helper indirectly. Vue's Suspense suite does this inside a describe.
  for (const match of maskedSource.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\.\s*bind\s*\(/g,
  )) {
    if (localHelpers.has(match[2])) localHelpers.add(match[1]);
  }

  // Lines inside `describe.skip(...)` are reported once at the container. The
  // placeholder tests inside must not also become `no-assertion` findings.
  const skippedDescribeLines = new Set();
  const describeSkip = /\bdescribe\s*\.\s*(?:skip|todo)\s*\(/g;
  let skipMatch;
  while ((skipMatch = describeSkip.exec(maskedSource)) !== null) {
    const open = maskedSource.indexOf('{', skipMatch.index + skipMatch[0].length);
    if (open === -1) continue;
    let depth = 0;
    let close = -1;
    for (let i = open; i < maskedSource.length; i += 1) {
      if (maskedSource[i] === '{') depth += 1;
      else if (maskedSource[i] === '}') {
        depth -= 1;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close === -1) continue;
    const first = maskedSource.slice(0, open).split('\n').length;
    const last = maskedSource.slice(0, close).split('\n').length;
    for (let line = first; line <= last; line += 1) skippedDescribeLines.add(line);
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
      const match = p.re.exec(haystack);
      if (!match) continue;
      // Some assertions need the raw line (the type name is a string literal), but
      // a whole fixture embedded in a string must still not be reported. The masked
      // copy has spaces at that position, so this requires real code at the match.
      if (p.needsStrings && (masked[match.index] ?? ' ').trim() === '') continue;

      // A promise assertion on its own line is fine when the previous line opens an
      // arrow body: `const guard = (p) =>` / `= async (p) =>`. That form returns the
      // promise and the caller awaits it.
      if (p.id === 'expect-in-callback-not-awaited') {
        const prev = (maskedLines[i - 1] ?? '').trimEnd();
        if (/=>$/.test(prev) || /=>\s*$/.test(prev)) continue;

        // Assigning the promise and awaiting it later is valid:
        //   const stopped = expect(p).rejects.toThrow();
        //   ...
        //   await stopped;
        // The assignment can also put `expect` on the following line.
        const before = masked.slice(0, match.index);
        const inlineAssign = before.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/);
        const multilineAssign = before.trim() === '' && prev.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/);
        const assigned = inlineAssign?.[1] ?? multilineAssign?.[1];
        if (assigned) {
          const awaited = new RegExp(
            String.raw`(?:\bawait\s+${assigned}\b|\breturn\s+${assigned}\b|\bPromise\s*\.\s*(?:all|allSettled|race)\s*\([^)]*\b${assigned}\b)`,
          );
          if (awaited.test(maskedSource)) continue;
        }
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
    const hasAssert = /\b(?:expect|assert\w*|should|expectTypeOf|assertType|expectAssignable)\b/.test(maskedBody)
      // Imported assertion helpers such as React's expectMarkupMismatch or
      // expectMarkupMatch have the assertion inside another module.
      || /\bexpect\w*\s*\(/.test(maskedBody)
      // SQLAlchemy's test helpers: eq_, is_, ne_, assert_raises, ...
      || /\b(?:eq_|ne_|is_|is_not_|expect_\w+|raises_\w+)\s*\(/.test(maskedBody)
      || /\bt\s*\.\s*(?:true|false|is|not|deepEqual|notDeepEqual|like|throws|throwsAsync|notThrows|snapshot|regex|pass|fail|ok|equal|same|plan|end|timeout)\s*\(/.test(maskedBody);

    const hasThrow = /\bthrow\b/.test(maskedBody);
    // A `try` without a swallowing catch is itself an assertion: if the call inside
    // fails, the test fails. axios has tests that only run a command and clean up.
    const hasTry = /\btry\s*\{/.test(maskedBody);
    // TypeScript tests can assert through the compiler. `@ts-expect-error` fails
    // the build when the next expression does NOT error, and `x satisfies T` fails
    // when it does not satisfy the type. Both are real assertions even though the
    // runtime body contains no expect().
    const rawBody = lines.slice(
      block.startLine - 1,
      block.startLine + block.body.split('\n').length - 1,
    ).join('\n');
    const hasTypeAssertion = /@ts-expect-error\b|\bsatisfies\s+[A-Za-z_$]/.test(rawBody);

    // Callback-style tests (mocha, jest): `function(done)` or `(done) =>`. Success is
    // reported by calling done(), failure by done(err) or by throwing. express has
    // seven of these, all legitimate.
    const headLine = lines[block.startLine - 1] ?? '';
    const hasDoneCallback = /\b(function\s*)?\(\s*(done|next)\s*\)/.test(headLine)
      || /async\s*\(\s*(done|next)\s*\)/.test(headLine);
    const callsDone = /\bdone\s*\(/.test(maskedBody);

    const isSkipped = skippedDescribeLines.has(block.startLine)
      || /\.\s*(skip|todo)\s*\(/.test(maskedLines[block.startLine - 1] ?? '');

    // Calling a helper defined in this file counts as possible assertion.
    const callsLocalHelper = [...localHelpers].some(
      (name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`).test(maskedBody),
    );

    // A custom decorator defined in this file can wrap the test with assertions.
    // @test_mutation() in Django's GIS suite is one example.
    const decoratorContext = lines
      .slice(Math.max(0, block.startLine - 8), block.startLine - 1)
      .join('\n');
    const callsLocalDecorator = [...decoratorContext.matchAll(/^[ \t]*@([A-Za-z_$][\w$]*)/gm)]
      .some((match) => localHelpers.has(match[1]));

    // An empty catch is already reported at line level with a clearer reason;
    // do not double-report the same test.
    //
    // The range is [startLine, startLine + bodyLines - 1]. Using +bodyLines without
    // the -1 reached one line past the block, so a finding on the *next* test
    // suppressed this one — which is why `test('clamp runs', () => { clamp(); })`
    // followed by a type-only assertion was never reported.
    const endLine = block.startLine + block.body.split('\n').length - 1;
    const alreadyReported = findings.some(
      (f) => f.line >= block.startLine && f.line <= endLine,
    );

    if (!hasAssert && !hasThrow && !hasTry && !hasTypeAssertion
      && !hasDoneCallback && !callsDone && !isSkipped && !alreadyReported
      && !callsLocalHelper && !callsLocalDecorator) {
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

      const explicitSmoke = /should\s+not\s+(?:throw|error|warn)|do(?:es)?\s+not\s+(?:throw|error|warn)|doesn'?t\s+throw|just\s+to\s+verify[^\n]*throw|not\s+throw|no\s+listeners|no\s+longer\s+expect|empty\s+test|@gate|allow\s+a\s+mocked\s+component.*rendered/i
        .test(`${originalName}\n${decoratorContext}\n${rawBody}`);
      // Validation libraries deliberately test success as "parse(valid) does
      // not throw". That is still a smoke test, not a certain fake test.
      const validationSmoke = /\.\s*(?:parse|safeParse|validate|validateSync)\s*\(/.test(maskedBody);
      // React's itRenders helper emits tests whose body is `testFn(renderer)`;
      // the assertions live in the caller's testFn.
      const helperGenerated = /^\s*testFn\s*\(/.test(maskedBody.trim());
      const smoke = explicitSmoke || validationSmoke || helperGenerated;
      findings.push({
        id: 'no-assertion',
        file: fileLabel,
        line: block.startLine,
        kind: 'empty',
        snippet: `it('${originalName}')`,
        why: smoke
          ? 'smoke test: it asserts no value, so it can only notice a thrown error'
          : thin
            ? 'test runs several statements but asserts nothing; it only fails if the code throws'
            : 'test calls code once and asserts nothing, so it passes even if the result is wrong',
        fix: 'assert on the result, or delete the test',
        thin,
        smoke,
      });
    }
  }

  // Django's unittest runner does not collect module-level test_* functions.
  // Those are helpers (for example test_processor), while pytest does collect them.
  const unittestFile = /from\s+django\.test\s+import|(?:class\s+\w+\s*\([^)]*\b(?:TestCase|SimpleTestCase|TransactionTestCase|IsolatedAsyncioTestCase)\b)/.test(maskedSource);

  // Python test functions: the same "no assertion" question, different syntax.
  for (const block of pythonTestBlocks(maskedSource)) {
    if (unittestFile && !block.inClass) continue;
    const maskedBody = maskStrings(block.body);
    const endLine = block.startLine + block.body.split('\n').length - 1;

    const pythonBody = block.body.split('\n').slice(1).join('\n');
    const hasAssert = /\b(?:expect|assert\w*|should)\b/.test(maskedBody)
      || /\b(?:eq_|ne_|is_|is_not_|expect_\w+|raises_\w+)\s*\(/.test(maskedBody)
      || /\bpytest\s*\.\s*raises\b/.test(maskedBody)
      || /\bwith\s+self\s*\.\s*assertRaises\b/.test(maskedBody)
      // Django's TestCase provides custom assertion helpers (check_html,
      // assertNumQueries, ...), and tests delegate to self._test_* or a parent's
      // test_* method. Those helpers contain the actual assertions.
      || /\b(?:self|super\s*\(\s*\))\s*\.\s*\w*(?:assert|check|verify|fail|test)\w*\s*\(/.test(maskedBody)
      // FastAPI's tutorial tests re-export assertions from docs_src:
      // `from ... import test_read_main; def test_main(): test_read_main()`.
      || /\btest_\w+\s*\(/.test(pythonBody);
    const hasThrow = /\braise\b/.test(maskedBody);
    const hasTry = /\btry\s*:/.test(maskedBody);

    // A decorator on the line(s) immediately above the def.
    // Multi-line decorators (`@testing.skip_if(\n lambda: True,\n reason\n)`)
    // can sit several lines above the def. Erring toward "skipped" is safe: it
    // keeps the finding visible but avoids a false certain no-assertion.
    const above = lines.slice(Math.max(0, block.startLine - 10), block.startLine - 1).join('\n');
    const isSkipped = /@\s*(?:pytest\s*\.\s*mark\s*\.\s*(?:skip|skipif|xfail)|unittest\s*\.\s*skip|(?:testing|unittest)\s*\.\s*skip(?:_if)?)\b/.test(above)
      || /@\s*testing\s*\.\s*skip_if\b/.test(maskedBody);

    // `except ValueError:` on one line and `pass` on the next is invisible to the
    // line scanner, so detect the swallowing pair inside the whole body.
    const swallow = maskedBody.match(/except\b[^:\n]*:\s*pass\b/);
    if (swallow) {
      findings.push({
        id: 'empty-catch-in-test',
        file: fileLabel,
        line: block.startLine + block.body.slice(0, swallow.index).split('\n').length - 1,
        kind: 'swallow',
        snippet: 'except ...: pass',
        why: 'swallows the error, so the test passes even when the call raises',
        fix: 'let the error fail the test, or assert on it',
      });
    }

    const alreadyReported = findings.some(
      (f) => f.line >= block.startLine && f.line <= endLine,
    );

    // Exclude the def line itself: otherwise the test's own name in localHelpers
    // makes callsLocalHelper match a non-existent recursive call.
    const callsLocalHelper = [...localHelpers].some(
      (name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`).test(pythonBody),
    );
    const decoratorContext = lines
      .slice(Math.max(0, block.startLine - 8), block.startLine - 1)
      .join('\n');
    const callsLocalDecorator = [...decoratorContext.matchAll(/^[ \t]*@([A-Za-z_$][\w$]*)/gm)]
      .some((match) => localHelpers.has(match[1]));

    if (hasAssert || hasThrow || hasTry || isSkipped || alreadyReported
      || callsLocalHelper || callsLocalDecorator) continue;

    const statements = block.body.split('\n').slice(1)
      .filter((text) => text.trim() && !/^\s*#/.test(text)).length;
    const rawBlock = lines.slice(block.startLine - 1, endLine).join('\n');
    const smoke = /no[_ ]exception|should\s+not\s+(?:throw|raise|error|warn)|does\s+not\s+(?:throw|raise|error|warn)|doesn'?t\s+(?:throw|raise)|just\s+to\s+verify[^\n]*(?:throw|raise)|just\s+for\s+coverage/i
      .test(`${block.name}\n${rawBlock}`);

    findings.push({
      id: 'no-assertion',
      file: fileLabel,
      line: block.startLine,
      kind: 'empty',
      snippet: `def ${block.name}()`,
      why: smoke
        ? 'smoke test: it asserts no value, so it can only notice a raised error'
        : statements > 1 || block.inClass
          ? 'test runs code but asserts nothing directly; it may rely on setUp/inherited helpers and can only notice exceptions'
          : 'test calls code once and asserts nothing, so it passes even if the result is wrong',
      fix: 'assert on the result, or delete the test',
      // A unittest-style class method may delegate assertions to a base class or
      // setUp; without cross-class analysis it is not provably a fake test.
      thin: statements > 1 || block.inClass,
      smoke,
    });
  }

  // Mocking the thing under test makes the test self-fulfilling.
  //
  // This needs the real text, because the module paths are inside quotes and the
  // masked copy has them blanked. We check that the mocked path and the imported
  // path are the same string, which is what makes the test assert its own mock.
  // Use the AST, not a regex over the file: sample code inside a string literal is
  // not a mock call, and treating it as one made crucible accuse its own tests.
  if (isJsFile(fileLabel)) {
    const { ast } = parseJs(source, fileLabel);
    if (ast) {
      const imports = new Set();
      const localImports = new Set();
      const mocks = [];
      walk(ast.program, (node) => {
        if (node.type === 'ImportDeclaration') {
          const spec = node.source.value;
          imports.add(spec);
          if (spec.startsWith('.') || spec.startsWith('/')) localImports.add(spec);
        }
        if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
          && !node.callee.computed
          && (node.callee.object.name === 'vi' || node.callee.object.name === 'jest')
          && node.callee.property.name === 'mock'
          && node.arguments[0]?.type === 'StringLiteral') {
          mocks.push({ flavour: node.callee.object.name, mockedPath: node.arguments[0].value, node });
        }
      });

      // A test importing several local modules usually mocks one collaborator.
      // Only the unambiguous shape — one local module, mocked by name — is
      // considered self-mocking. External packages are collaborators, not the
      // unit under test.
      if (localImports.size === 1) {
        for (const mock of mocks) {
          if (!imports.has(mock.mockedPath) || !localImports.has(mock.mockedPath)) continue;
          findings.push({
            id: 'mock-self',
            file: fileLabel,
            line: mock.node.loc.start.line,
            kind: 'self-fulfilling',
            snippet: `${mock.flavour}.mock('${mock.mockedPath}') on the module the test imports`,
            why: 'the test replaces the only local module it imports, so it asserts the mock, not the code',
            fix: 'mock collaborators, not the unit under test',
          });
          break;
        }
      }
    }
  }

  // The line scanner and the block scanner can see the same construct — a one-line
  // `except ValueError: pass` hits both. One location is one finding, otherwise
  // `check` counts (and prints) it twice.
  const unique = new Map();
  for (const f of findings) {
    if (ignore.ids.has(f.id)) continue;
    const key = `${f.id}:${f.line}`;
    if (!unique.has(key)) unique.set(key, f);
  }
  return [...unique.values()];
}

/**
 * Count real assertions in a file, for the summary line.
 */
export function assertionCount(source) {
  const matches = source.match(/\b(expect\s*\(|assert\w*\s*\()/g);
  return matches ? matches.length : 0;
}
