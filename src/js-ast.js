/**
 * JavaScript/TypeScript parsing shared by mutation and static analysis.
 *
 * Parser failures are data, not permission to fall back to guessing. A caller can
 * skip the file and explain why; it must not report regex matches as proven facts.
 */
import { parse } from '@babel/parser';
import { extname } from 'node:path';

export function isJsFile(file = '') {
  return /\.[cm]?[jt]sx?$/i.test(file);
}

export function parseJs(source, file = 'source.js') {
  const jsx = /\.[jt]sx$/i.test(file) || /\.[cm]?js$/i.test(file);
  const typescript = /\.[cm]?tsx?$/i.test(file);
  const plugins = [
    'importAttributes', 'explicitResourceManagement', 'decorators-legacy',
    'classProperties', 'classPrivateProperties', 'classPrivateMethods',
    'privateIn', 'topLevelAwait', ...(jsx ? ['jsx'] : []),
    ...(typescript ? ['typescript'] : []),
  ];

  try {
    return {
      ast: parse(source, {
        sourceType: 'unambiguous', allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: true, errorRecovery: false, plugins,
      }),
      error: null,
    };
  } catch (error) {
    // Flow and TS projects occasionally use syntax Babel cannot enable together.
    // A failed parse is deliberately retained for the report, never hidden.
    return { ast: null, error: error.message };
  }
}

/** Every supported file gets a real parse check before a mutant is executed. */
export function validateSource(source, file = 'source.js') {
  if (!isJsFile(file)) return null;
  return parseJs(source, file).ast ? source : null;
}

export function walk(node, visit, parent = null) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string' && visit(node, parent) === false) return;
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'start', 'end', 'range', 'leadingComments', 'trailingComments', 'innerComments', 'extra', 'comments', 'tokens'].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit, node);
    } else if (value && typeof value === 'object') {
      walk(value, visit, node);
    }
  }
}

export function singleLineSpan(node) {
  if (!node?.loc || node.loc.start.line !== node.loc.end.line) return null;
  return {
    start: node.start,
    end: node.end,
    line: node.loc.start.line,
    column: node.loc.start.column + 1,
  };
}

/** Precomputed newline offsets: computing `before.split` per candidate is O(n²). */
export function sourceLineIndex(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') starts.push(i + 1);
  return starts;
}

/** The single line affected by a node, including original source offsets. */
export function lineEdit(source, start, end, replacement, starts = sourceLineIndex(source)) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid] <= start) low = mid;
    else high = mid - 1;
  }
  const lineStart = starts[low];
  const lineEnd = low + 1 < starts.length ? starts[low + 1] - 1 : source.length;
  const originalLine = source.slice(lineStart, lineEnd);
  return {
    line: low + 1,
    column: start - lineStart + 1,
    mutated: source.slice(lineStart, start) + replacement + source.slice(end, lineEnd),
    original: source.slice(start, end),
    originalLine,
  };
}
