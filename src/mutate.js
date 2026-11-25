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
 * @param {string} source
 * @param {string} fileLabel
 * @returns {Mutation[]}
 */
export function mutationsFor(source, fileLabel = 'source') {
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

    // 1. Operators (comparisons, booleans, arithmetic).
    for (const { start, end, op } of findOperators(masked)) {
      push(op.kind, start, end, op.to, op.label);
    }

    // 2. Numeric literals: 0 -> 1, n -> n+1. Catches "returns the right number" claims.
    NUMBER_LITERALS.lastIndex = 0;
    let numMatch;
    while ((numMatch = NUMBER_LITERALS.exec(masked)) !== null) {
      const value = Number(numMatch[1]);
      const bumped = value === 0 ? '1' : String(value + 1);
      push('number', numMatch.index, numMatch.index + numMatch[1].length, bumped,
        `bump ${numMatch[1]} to ${bumped}`);
    }

    // 3. Literal boolean returns.
    const retMatch = masked.match(/\breturn\s+(true|false)\b/);
    if (retMatch) {
      const start = retMatch.index + retMatch[0].length - retMatch[1].length;
      push('return', start, start + retMatch[1].length,
        retMatch[1] === 'true' ? 'false' : 'true', `flip return ${retMatch[1]}`);
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
};
