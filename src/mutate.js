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

/** @typedef {{ id: string, kind: string, line: number, original: string, mutated: string, description: string }} Mutation */

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
 * Strip string literals and comments so we never mutate prose.
 * Returns a string of identical length where masked characters become spaces,
 * so every index in the result maps to the same index in the original line.
 */
function maskLiterals(line) {
  let out = '';
  let i = 0;
  let quote = null;
  let inBlockComment = false;

  while (i < line.length) {
    const ch = line[i];
    const next = line[i + 1];

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        out += '  ';
        i += 2;
        continue;
      }
      out += ' ';
      i += 1;
      continue;
    }

    if (quote) {
      if (ch === '\\') {
        out += '  ';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      out += ' ';
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') break;
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      out += '  ';
      i += 2;
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
 * Find operator positions in a masked line, longest match wins.
 * Each position is claimed at most once so we never emit two mutations that
 * target the same characters.
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

    found.push({ start: i, end: i + matched.from.length, op: matched });
    i += matched.from.length;
  }

  return found;
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
  const profile = options.profile ?? 'logic';
  const strict = profile === 'strict';

  const lines = source.split('\n');
  /** @type {Mutation[]} */
  const out = [];
  let counter = 0;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const raw = lines[idx];
    if (!raw.trim() || SKIP_LINE.test(raw)) continue;

    const masked = maskLiterals(raw);
    if (!masked.trim()) continue;

    const push = (kind, start, end, replacement, description) => {
      const original = raw.slice(start, end);
      if (original === replacement) return;
      counter += 1;
      out.push({
        id: `${fileLabel}:${idx + 1}:${counter}`,
        kind,
        line: idx + 1,
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
    //    A fresh regex per line: the shared one carries lastIndex between calls.
    const strings = /(['"])((?:\\.|(?!\1).)*)\1/g;
    let strMatch;
    while ((strMatch = strings.exec(raw)) !== null) {
      const content = strMatch[2];
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
