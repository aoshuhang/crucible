/**
 * Mutation operators.
 *
 * A test is "real" only if it fails when the code it covers breaks. Each operator
 * below takes source text and returns mutated variants. A survivor (test suite
 * still green after the mutation) is hard evidence that some test asserts nothing
 * meaningful about that line.
 *
 * Operators are deliberately conservative: we only emit mutations that are
 * syntactically local and semantically meaningful. A mutation that changes
 * formatting or comments proves nothing.
 */

import { isJsFile, validateSource } from './js-ast.js';
import { jsMutationsDetailed } from './js-mutate.js';
import { pythonMutationsDetailed } from './python-mutate.js';
import { goSourceIsActive } from './go-build.js';

/** @typedef {{ id: string, kind: string, line: number, column: number, original: string, mutated: string, description: string }} Mutation */

/**
 * Operator table. Order matters: longest first, because the scanner consumes
 * the longest match at each position. This keeps `===` from being read as `==`
 * and stops overlapping rewrites from cancelling each other out.
 */
const OPERATORS = [
  { kind: 'comparison', from: '===', to: '!==', label: 'flip === to !==' },
  { kind: 'comparison', from: '!==', to: '===', label: 'flip !== to ===' },
  { kind: 'comparison', from: '>=', to: '>', label: 'flip >= to >' },
  { kind: 'comparison', from: '<=', to: '<', label: 'flip <= to <' },
  { kind: 'comparison', from: '==', to: '!=', label: 'flip == to !=' },
  { kind: 'comparison', from: '!=', to: '==', label: 'flip != to ==' },
  // Bare > and < last, so >= and <= win at their positions.
  { kind: 'comparison', from: '>', to: '>=', label: 'flip > to >=' },
  { kind: 'comparison', from: '<', to: '<=', label: 'flip < to <=' },
  { kind: 'boolean', from: '&&', to: '||', label: 'flip && to ||' },
  { kind: 'boolean', from: '||', to: '&&', label: 'flip || to &&' },
  { kind: 'arithmetic', from: '+', to: '-', label: 'flip + to -' },
  { kind: 'arithmetic', from: '-', to: '+', label: 'flip - to +' },
  { kind: 'arithmetic', from: '*', to: '/', label: 'flip * to /' },
  { kind: 'arithmetic', from: '/', to: '*', label: 'flip / to *' },
];

const NUMBER_LITERALS = /\b(\d+(?:\.\d+)?)\b/g;

/** Lines that are noise for mutation purposes. */
const SKIP_LINE = /^\s*(\/\/|\/\*|\*|#|import\s|from\s|require\(|'use strict'|"use strict")/;

/**
 * Words after which a `/` starts a regex literal, not division.
 * `return /x/` is a regex; `a / b` is division. Telling them apart by the previous
 * significant token is the classic heuristic and covers real code.
 */
const REGEX_PRECEDING_WORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
]);

/**
 * Mask string/template/comment/regex contents across a WHOLE file.
 *
 * Returns a string of identical length where masked characters become spaces, so
 * every index in the result maps to the same index in the original.
 *
 * This used to run per line, which could not carry state across a newline: the
 * second line of a block comment, the continuation of a template literal holding
 * SQL, and regex bodies all looked like live code and got mutated. A mutant that
 * only breaks prose is either a syntax error (falsely counted as a kill) or a
 * no-op — both corrupt the score.
 *
 * String, template and regex delimiters are KEPT and only their contents are
 * blanked, so the string operator can still locate literals by their quotes and
 * map positions back to the original text. `${ … }` interpolation markers are
 * blanked, the code inside them is not — that is real code.
 */
function maskCode(source) {
  const n = source.length;
  const out = Array.from(source);
  const blank = (i) => { if (source[i] !== '\n') out[i] = ' '; };

  let i = 0;
  let prevCode = '';   // last significant character seen in code mode
  let prevWord = '';   // last identifier seen in code mode
  const stack = [];    // nested template contexts: { kind: 'tpl' } | { kind: 'interp', braces }

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1] ?? '';
    if (ch === '\n') { i += 1; continue; }

    const top = stack[stack.length - 1];

    if (top?.kind === 'tpl') {
      if (ch === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      if (ch === '`') { blank(i); stack.pop(); i += 1; prevCode = '`'; prevWord = ''; continue; }
      if (ch === '$' && next === '{') {
        blank(i); blank(i + 1);
        stack.push({ kind: 'interp', braces: 0 });
        i += 2; prevCode = '{'; prevWord = '';
        continue;
      }
      blank(i); i += 1; continue;
    }

    // A `${` interpolation counts its own braces so `${ { a: 1 } }` ends at the
    // right `}`, not at the first one.
    if (top?.kind === 'interp') {
      if (ch === '{') { top.braces += 1; prevCode = '{'; prevWord = ''; i += 1; continue; }
      if (ch === '}') {
        if (top.braces > 0) { top.braces -= 1; prevCode = '}'; prevWord = ''; i += 1; continue; }
        blank(i); stack.pop(); i += 1; prevCode = '}'; prevWord = '';
        continue;
      }
    }

    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') { blank(i); i += 1; }
      continue; // comments never change what may follow them
    }
    if (ch === '/' && next === '*') {
      blank(i); blank(i + 1); i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) { blank(i); i += 1; }
      if (i < n) { blank(i); blank(i + 1); i += 2; }
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      blank(i); i += 1;
      while (i < n && source[i] !== quote && source[i] !== '\n') {
        if (source[i] === '\\') { blank(i); blank(i + 1); i += 2; continue; }
        blank(i); i += 1;
      }
      if (i < n && source[i] === quote) { blank(i); i += 1; }
      prevCode = quote; prevWord = '';
      continue;
    }
    if (ch === '`') { blank(i); stack.push({ kind: 'tpl' }); i += 1; prevCode = '`'; prevWord = ''; continue; }
    if (ch === '/' && regexStartsHere(prevCode, prevWord)) {
      blank(i); i += 1;
      let inClass = false;
      while (i < n) {
        const c = source[i];
        if (c === '\\') { blank(i); blank(i + 1); i += 2; continue; }
        if (c === '\n') break; // not a regex after all; stop masking, keep going
        if (c === '[') { inClass = true; blank(i); i += 1; continue; }
        if (c === ']') { inClass = false; blank(i); i += 1; continue; }
        if (c === '/' && !inClass) { blank(i); i += 1; break; }
        blank(i); i += 1;
      }
      while (i < n && /[a-z]/i.test(source[i])) { blank(i); i += 1; } // flags
      prevCode = '/'; prevWord = '';
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < n && /[\w$]/.test(source[j])) j += 1;
      prevWord = source.slice(i, j);
      prevCode = 'w';
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      // A number is an operand: `100 / 5` is division, not the start of a regex.
      // Treating digits as operand context (like identifiers) keeps the division
      // operator mutable.
      let j = i;
      while (j < n && /[\w.]/.test(source[j])) j += 1;
      prevWord = '';
      prevCode = 'w';
      i = j;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i += 1; continue; }
    prevCode = ch; prevWord = '';
    i += 1;
  }

  return out.join('');
}

/** A `/` here starts a regex literal rather than division. */
function regexStartsHere(prevCode, prevWord) {
  if (prevWord && REGEX_PRECEDING_WORDS.has(prevWord)) return true;
  // After an operand the `/` must be division.
  if (prevCode === 'w' || prevCode === ')' || prevCode === ']' || prevCode === '"'
    || prevCode === "'" || prevCode === '`' || prevCode === '/' || prevCode === '}') return false;
  return true; // start of file, or after ( , = : ; ! ? & | etc.
}

/**
 * A line that only assigns a literal: `let maxHealth = 34;`
 *
 * These are the tuning constants of a program — health, speed, damage, tax rates.
 * Bumping one usually produces an equivalent mutant from the test suite's point of
 * view, because pinning every magic number would turn tests into a maintenance
 * burden that fails on every balance change.
 *
 * The match must be strict: the right-hand side has to be a single literal, not an
 * expression. `const visible = a > b` is logic and must still be mutated.
 *
 * Under the `logic` profile we skip these; under `strict` we mutate them.
 */
const DECLARATION_ONLY = /^\s*(?:let|const|var)\s+[\w$]+\s*(?::\s*[^=]+)?=\s*(?:-?\d+(?:\.\d+)?|true|false|null|undefined)\s*;?\s*$/;

/** A string literal in a return or assignment: `return 'full';` */

/**
 * Find operator positions in a masked line, longest match wins.
 * Each position is claimed at most once so we never emit two mutations that
 * target the same characters.
 *
 * Comparison operators are only counted where a comparison can exist — an
 * operand-shaped token on both sides. This is what keeps
 *   xs.map(x => x * 2)          — an arrow, not `=` + `>`
 *   (x << 2) + (x >> 1)         — shifts, not comparisons
 *   Map<string, number>         — TS generics
 *   <div>…</div>                — JSX
 * from producing mutants that are pure syntax errors, get falsely counted as
 * KILLED, and inflate the mutation score.
 * @returns {{ start: number, end: number, op: typeof OPERATORS[number] }[]}
 */
function findOperators(masked) {
  const found = [];
  let i = 0;

  while (i < masked.length) {
    let matched = null;
    for (const op of OPERATORS) {
      if (masked.startsWith(op.from, i)) {
        matched = op;
        break;
      }
    }

    if (!matched) {
      i += 1;
      continue;
    }

    // A '+' or '-' is arithmetic only when it is a binary operator: there must be
    // an operand before and after it. Skip unary signs like `-1` and `return -x`.
    if (matched.kind === 'arithmetic') {
      const before = masked.slice(0, i).trimEnd();
      const after = masked.slice(i + matched.from.length).trimStart();
      const operandBefore = /[\w)\]'"]$/.test(before);
      const operandAfter = /^[\w(\['"]/.test(after);
      if (!operandBefore || !operandAfter) {
        i += 1;
        continue;
      }
    }

    if (matched.kind === 'comparison') {
      const before = masked.slice(0, i).trimEnd();
      const after = masked.slice(i + matched.from.length).trimStart();
      // An operand may start with a unary sign: `a > -1` is a real comparison.
      const operandBefore = /[\w)\]'"`]$/.test(before);
      const operandAfter = /^[\w(\['"`-]/.test(after);
      if (!operandBefore || !operandAfter) {
        i += 1;
        continue;
      }
      // `=>` is an arrow function, not `=` followed by `>`: a `>` whose preceding
      // non-space char is `=` is the arrow's head, never a comparison.
      if (masked[i] === '>' && before.endsWith('=')) {
        i += 1;
        continue;
      }
    }

    found.push({ start: i, end: i + matched.from.length, op: matched });
    i += matched.from.length;
  }

  return found;
}

/**
 * End of an expression that starts at `start`: a `;`, a comma at depth 0, or an
 * unmatched closer.
 */
function expressionEnd(masked, start) {
  let depth = 0;
  for (let i = start; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return i;
      depth -= 1;
    } else if ((ch === ';' || ch === ',') && depth === 0) {
      // A comma ends the expression inside an array, argument list or object
      // literal. Without this, `[a ? b : c, d]` swapped in the whole `c, d`.
      return i;
    }
  }
  return masked.length;
}

/**
 * Locate a single-line ternary: `cond ? then : otherwise`.
 *
 * Optional chaining (`?.`) and nullish coalescing (`??`) look similar and are not
 * ternaries. A nested ternary is skipped rather than half-rewritten.
 */
function findTernary(masked) {
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] !== '?') continue;
    if (masked[i + 1] === '?' || masked[i + 1] === '.') {
      i += 1;
      continue;
    }

    let depth = 0;
    let colon = -1;
    for (let j = i + 1; j < masked.length; j += 1) {
      const ch = masked[j];
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
      else if (ch === ':' && depth === 0) {
        colon = j;
        break;
      } else if (ch === '?' && depth === 0) {
        return null; // nested ternary: not worth a half-correct rewrite
      }
    }

    if (colon === -1) return null;
    return { question: i, colon, end: expressionEnd(masked, colon + 1) };
  }
  return null;
}

/**
 * Yield candidate mutations for one file's source text.
 *
 * @param {string} source
 * @param {string} [fileLabel]
 * @param {{ profile?: 'logic'|'strict' }} [options]
 *   logic  (default) skips declaration-only lines: tuning constants are not a test
 *          quality signal.
 *   strict mutates everything, including constants.
 * @returns {Mutation[]}
 */
export function mutationsFor(source, fileLabel = 'source', options = {}) {
  return mutationsDetailed(source, fileLabel, options).mutations;
}

/**
 * Mutation generation with an explicit failure state.
 * JS/TS and Python use their language parsers. Other languages retain the
 * conservative lexical operators and are identified in the report.
 */
export function mutationsDetailed(source, fileLabel = 'source', options = {}) {
  if (isJsFile(fileLabel)) return jsMutationsDetailed(source, fileLabel, options);
  if (/\.py$/i.test(fileLabel)) return pythonMutationsDetailed(source, fileLabel, options);
  if (/\.go$/i.test(fileLabel) && !goSourceIsActive(source)) {
    return {
      mutations: [],
      parseError: null,
      available: 0,
      language: 'go',
      skippedReason: 'the file is excluded from the current build by a //go:build constraint',
    };
  }
  return { mutations: lexicalMutations(source, fileLabel, options), parseError: null, available: null, language: 'lexical' };
}

function lexicalMutations(source, fileLabel = 'source', options = {}) {
  const profile = options.profile ?? 'logic';
  const strict = profile === 'strict';

  const lines = source.split('\n');
  // Masked ONCE for the whole file: string/template/comment/regex state must carry
  // across newlines, or the continuation lines of a block comment or a template
  // literal holding SQL look like live code and get mutated.
  const maskedSource = maskCode(source);
  const maskedLines = maskedSource.split('\n');
  /** @type {Mutation[]} */
  const out = [];
  let counter = 0;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const raw = lines[idx];
    if (!raw.trim() || SKIP_LINE.test(raw)) continue;

    const masked = maskedLines[idx] ?? '';
    if (!masked.trim()) continue;

    const push = (kind, start, end, replacement, description) => {
      const original = raw.slice(start, end);
      if (original === replacement) return;
      counter += 1;
      out.push({
        id: `${fileLabel}:${idx + 1}:${counter}`,
        kind,
        line: idx + 1,
        column: start + 1,
        original,
        mutated: raw.slice(0, start) + replacement + raw.slice(end),
        description,
      });
    };

    const declarationOnly = DECLARATION_ONLY.test(raw);

    // 1. Operators (comparisons, booleans, arithmetic).
    //    Arithmetic inside a declaration is a formula, not a constant, so it is
    //    still worth mutating under the logic profile.
    for (const { start, end, op } of findOperators(masked)) {
      if (declarationOnly && !strict && op.kind === 'arithmetic') {
        // `let speed = 5.6 + 0.4 * (size - 1)` — this is a formula. Mutating it
        // is legitimate: it changes behaviour, not tuning.
        push(op.kind, start, end, op.to, op.label);
        continue;
      }
      if (declarationOnly && !strict && op.kind === 'boolean') continue;
      push(op.kind, start, end, op.to, op.label);
    }

    // 1b. Ternary branch swap: `cond ? a : b` -> `cond ? b : a`.
    //     Catches a conditional nobody checks in both directions.
    //     Skipped inside a template interpolation: maskCode blanks the closing `}`
    //     of `${...}`, so the boundary check runs on the raw line instead. The
    //     range is [question, end) — a `}` AT `end` is an object literal's own
    //     brace, not an interpolation boundary; a `}` BEFORE `end` means it
    //     truncated the else-branch.
    const ternary = findTernary(masked);
    if (ternary) {
      const thenPart = raw.slice(ternary.question + 1, ternary.colon).trim();
      const elsePart = raw.slice(ternary.colon + 1, ternary.end).trim();
      const crossesInterpolation = raw.slice(ternary.question, ternary.end).includes('}');
      if (thenPart && elsePart && thenPart !== elsePart && !crossesInterpolation) {
        push('condition', ternary.question, ternary.end,
          `? ${elsePart} : ${thenPart}`, 'swap the ternary branches');
      }
    }

    // 2. Numeric literals. Under the logic profile a bare constant declaration is
    //    skipped, because pinning every tuning number is not a quality signal.
    if (!(declarationOnly && !strict)) {
      NUMBER_LITERALS.lastIndex = 0;
      let numMatch;
      while ((numMatch = NUMBER_LITERALS.exec(masked)) !== null) {
        const value = Number(numMatch[1]);
        const bumped = value === 0 ? '1' : String(value + 1);
        push('number', numMatch.index, numMatch.index + numMatch[1].length, bumped,
          `bump ${numMatch[1]} to ${bumped}`);
      }
    }

    // 3. Literal boolean returns.
    const retMatch = masked.match(/\breturn\s+(true|false)\b/);
    if (retMatch) {
      const start = retMatch.index + retMatch[0].length - retMatch[1].length;
      push('return', start, start + retMatch[1].length,
        retMatch[1] === 'true' ? 'false' : 'true', `flip return ${retMatch[1]}`);
    }

    // 4. Condition negation: `if (x)` -> `if (!x)`.
    //    Catches branches that are never exercised in both directions.
    const condMatch = masked.match(/\b(if|while)\s*\(\s*(?![!(])/);
    if (condMatch) {
      const open = condMatch.index + condMatch[0].length;
      // Find the matching close paren to wrap the whole condition.
      let depth = 1;
      let close = -1;
      for (let i = open; i < masked.length; i += 1) {
        if (masked[i] === '(') depth += 1;
        else if (masked[i] === ')') {
          depth -= 1;
          if (depth === 0) { close = i; break; }
        }
      }
      if (close !== -1) {
        push('condition', open, close, `!(${raw.slice(open, close)})`,
          'negate the condition');

        // A second, stronger mutant: force the branch true. Negation can be an
        // equivalent mutant when the body is symmetric; forcing true cannot.
        const condition = raw.slice(open, close).trim();
        if (condition && condition !== 'true') {
          push('condition', open, close, 'true', 'force the condition true');
        }
      }
    }

    // 5. Statement removal: a bare `return expr;` becomes `return undefined;`.
    //    Catches return values nobody checks.
    const bareReturn = masked.match(/\breturn\s+([^;]+);/);
    if (bareReturn && !/\breturn\s+(true|false)\b/.test(masked)) {
      const start = bareReturn.index + bareReturn[0].indexOf('return') + 'return'.length;
      const end = bareReturn.index + bareReturn[0].length - 1;
      push('statement', start, end, ' undefined', 'drop the returned value');
    }

    // 6. String literals in returns or comparisons: `'full'` -> `''`.
    //    Catches status strings that no test asserts.
    //    The masked line keeps quote delimiters (contents blanked), so scanning the
    //    RAW line inside the delimiters is still correct here.
    const strings = /(['"])((?:\\.|(?!\1).)*)\1/g;
    let strMatch;
    while ((strMatch = strings.exec(masked)) !== null) {
      const content = raw.slice(strMatch.index + 1, strMatch.index + strMatch[0].length - 1);
      if (content.length === 0) continue;
      if (content.length > 40) continue;
      // Skip module specifiers and obvious paths.
      if (/^[./]/.test(content) || content.includes('/')) continue;
      // Only mutate when the string is used as a value, not as an object key.
      // An object key looks like `{ 'a': 1 }` or `, 'b': 2` — the colon comes
      // right after the string and the string follows a brace or comma.
      const after = raw.slice(strMatch.index + strMatch[0].length);
      const before = raw.slice(0, strMatch.index).trimEnd();
      const isObjectKey = /^\s*:/.test(after) && /[{,]$/.test(before);
      if (isObjectKey) continue;
      push('string', strMatch.index, strMatch.index + strMatch[0].length, '""',
        `empty the string ${JSON.stringify(content)}`);
    }
  }

  return out;
}

/**
 * Apply one mutation to source text.
 * @param {string} source
 * @param {Mutation} mutation
 * @returns {string}
 */
export function applyMutation(source, mutation) {
  const lines = source.split('\n');
  lines[mutation.line - 1] = mutation.mutated;
  return lines.join('\n');
}

export const operators = {
  comparison: 'flips ===/!==, >=/>, </<= and friends',
  boolean: 'flips && with ||',
  arithmetic: 'flips + with -',
  number: 'bumps numeric literals by one',
  return: 'flips a literal true/false return',
  condition: 'negates an if/while condition',
  statement: 'drops a returned value',
  string: 'empties a string literal',
};

/**
 * Parse-check a JavaScript source text WITHOUT executing it, using `new Function`.
 *
 * `new Function(body)` compiles the body and throws only on SyntaxError; it never
 * runs the code. This is the syntax gate for generated mutants without a filename:
 * a mutant that cannot parse is a guaranteed test failure for reasons that have
 * nothing to do with test quality, and counting it as KILLED inflates the score.
 *
 * Module syntax (import/export) is illegal in a FunctionBody, so it is stripped
 * first; a plain expression is wrapped in a function body to be a legal script.
 * Returns the parseable form, or null when the text cannot be parsed at all.
 *
 * @param {string} source
 * @param {string|null} [file] file label used only to decide JS vs not-JS
 * @returns {string|null}
 */
export function parsesAsScript(source, file = null) {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(nodeMajor)) return null;
  if (nodeMajor < 20) return null;

  // All JS/TS/JSX variants now have a real parser. The old `new Function` fallback
  // is retained only for callers that pass a code fragment with no filename.
  if (file) return validateSource(source, file) === null ? null : source;

  const body = source;
  const candidates = [];

  // Module syntax must be stripped before FunctionBody parsing. `export default`
  // needs its own pattern: stripping just the `export` keyword leaves a bare
  // `default function`, which is not legal script syntax.
  if (/^\s*(import|export)\s/m.test(body)) {
    candidates.push(
      body.replace(/^\s*import[^\n]*\n?/gm, '\n')
        .replace(/^\s*export\s+default\s+/gm, '')
        .replace(/^\s*export\s+/gm, ''),
    );
  }
  // A plain expression needs a script wrapper to parse.
  if (!/^\s*(?:function|class|if|for|while|const|let|var|async|\/\*)/m.test(body)) {
    candidates.push(`(0, function(){\n${body}\n})`);
  }
  candidates.push(body);

  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line no-new-func
      new Function(candidate); // throws only on SyntaxError, never executes
      return candidate;
    } catch { /* try the next wrapping */ }
  }
  return null;
}
