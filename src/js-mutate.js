/** AST-driven JavaScript and TypeScript mutation operators. */
import { parseJs, walk, singleLineSpan, lineEdit, sourceLineIndex } from './js-ast.js';

const COMPARISON = new Map([
  ['===', '!=='], ['!==', '==='], ['>=', '>'], ['<=', '<'],
  ['==', '!='], ['!=', '=='], ['>', '>='], ['<', '<='],
]);
const ARITHMETIC = new Map([['+', '-'], ['-', '+'], ['*', '/'], ['/', '*']]);
const BOOLEAN = new Map([['&&', '||'], ['||', '&&']]);

function literalDeclaration(node, parent) {
  // An exported constant is public behaviour, not a private tuning knob. Keep the
  // long-standing rule: only non-exported single-literal declarations are skipped.
  return parent?.type !== 'ExportNamedDeclaration'
    && node.type === 'VariableDeclaration' && node.declarations.length === 1
    && ['NumericLiteral', 'BooleanLiteral', 'NullLiteral', 'Identifier'].includes(node.declarations[0].init?.type)
    && (node.declarations[0].init.type !== 'Identifier' || node.declarations[0].init.name === 'undefined');
}

function isLoop(node, parent) {
  return ['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement'].includes(parent?.type)
    && parent.test === node;
}

function moduleString(node, parent) {
  if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(parent?.type)) return true;
  return parent?.type === 'CallExpression' && parent.arguments.includes(node)
    && (parent.callee.type === 'Import'
      || (parent.callee.type === 'Identifier' && parent.callee.name === 'require'));
}

export function jsMutationsDetailed(source, fileLabel = 'source.js', options = {}) {
  const { ast, error } = parseJs(source, fileLabel);
  if (!ast) return { mutations: [], parseError: error, available: 0 };

  const strict = options.profile === 'strict';
  const out = [];
  const lineStarts = sourceLineIndex(source);
  const push = (node, start, end, replacement, kind, description) => {
    const span = singleLineSpan(node);
    if (!span) return;
    const edit = lineEdit(source, start, end, replacement, lineStarts);
    if (edit.original === replacement || edit.mutated === edit.originalLine) return;
    // AST edits are syntax-preserving by construction. Full-file re-parsing every
    // candidate made large files quadratic; the selected mutants are parse-gated
    // once in buildPlan before any test run.
    out.push({
      id: `${fileLabel}:${edit.line}:${edit.column}:${kind}:${out.length + 1}`,
      kind, line: edit.line, column: edit.column, original: edit.original,
      mutated: edit.mutated, description, language: 'javascript',
    });
  };

  walk(ast.program, (node, parent) => {
    if (node.type === 'VariableDeclaration' && literalDeclaration(node, parent) && !strict) return false;

    if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') {
      const op = node.operator;
      const start = node.left.end;
      const end = node.right.start;
      const operatorText = source.slice(start, end);
      const index = operatorText.indexOf(op);
      if (index === -1 || isLoop(node, parent)) return;
      const replacement = COMPARISON.get(op) ?? BOOLEAN.get(op) ?? ARITHMETIC.get(op);
      if (!replacement) return;
      const kind = COMPARISON.has(op) ? 'comparison' : BOOLEAN.has(op) ? 'boolean' : 'arithmetic';
      push(node, start + index, start + index + op.length, replacement, kind, `flip ${op} to ${replacement}`);
      return;
    }

    if (node.type === 'NumericLiteral') {
      // A skipped literal declaration never reaches its children (the walk stopped
      // at the declaration), so no second skip check is needed here.
      push(node, node.start, node.end, String(node.value === 0 ? 1 : node.value + 1), 'number', `bump ${node.value} to ${node.value === 0 ? 1 : node.value + 1}`);
      return;
    }

    if (node.type === 'StringLiteral') {
      if (moduleString(node, parent) || parent?.type === 'Directive'
        || (['ObjectProperty', 'ObjectMethod', 'ClassMethod', 'ClassProperty'].includes(parent?.type) && parent.key === node)
        || node.value.length === 0 || node.value.length > 40) return;
      push(node, node.start, node.end, JSON.stringify(''), 'string', `empty the string ${JSON.stringify(node.value)}`);
      return;
    }

    if ((node.type === 'IfStatement' || node.type === 'WhileStatement') && node.test) {
      const test = node.test;
      if (test.type === 'UnaryExpression' && test.operator === '!') return;
      const text = source.slice(test.start, test.end);
      push(test, test.start, test.end, `!(${text})`, 'condition', 'negate the condition');
      if (test.type !== 'BooleanLiteral' || test.value !== true) {
        push(test, test.start, test.end, 'true', 'condition', 'force the condition true');
      }
      return;
    }

    if (node.type === 'ConditionalExpression') {
      const yes = source.slice(node.consequent.start, node.consequent.end);
      const no = source.slice(node.alternate.start, node.alternate.end);
      if (yes !== no) push(node, node.consequent.start, node.alternate.end, `${no} : ${yes}`, 'condition', 'swap the ternary branches');
      return;
    }

    if (node.type === 'ReturnStatement' && node.argument) {
      const argument = node.argument;
      if (argument.type === 'BooleanLiteral') {
        push(argument, argument.start, argument.end, String(!argument.value), 'return', `flip return ${argument.value}`);
      } else {
        push(argument, argument.start, argument.end, 'undefined', 'statement', 'drop the returned value');
      }
    }
  });

  out.sort((a, b) => a.line - b.line || a.column - b.column || a.id.localeCompare(b.id));
  out.forEach((m, index) => { m.id = `${fileLabel}:${m.line}:${m.column}:${m.kind}:${index + 1}`; });
  return { mutations: out, parseError: null, available: out.length };
}

export function jsMutations(source, fileLabel = 'source.js', options = {}) {
  return jsMutationsDetailed(source, fileLabel, options).mutations;
}
