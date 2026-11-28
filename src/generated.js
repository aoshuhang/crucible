/**
 * Contract checks for every file crucible writes.
 *
 * A generated test must parse and contain at least one assertion. Without this,
 * `fix` can emit a green file that cannot fail, which is the defect the product
 * exists to find.
 */
import { parseJs, walk, isJsFile } from './js-ast.js';
import { pythonMutationsDetailed } from './python-mutate.js';

function jsAssertions(node) {
  let count = 0;
  walk(node, (child) => {
    if (child.type !== 'CallExpression') return;
    const callee = child.callee;
    if (callee.type === 'MemberExpression' && !callee.computed) {
      const object = callee.object;
      const property = callee.property?.name ?? '';
      if ((object.type === 'CallExpression' && object.callee.name === 'expect')
        || (object.type === 'Identifier' && object.name === 'assert')) count += 1;
      if (object.type === 'Identifier' && object.name === 't'
        && /^(?:true|false|is|not|deepEqual|throws|pass|fail|ok|regex)$/.test(property)) count += 1;
    }
    if (callee.type === 'Identifier' && callee.name === 'assert') count += 1;
  });
  return count;
}

export function validateGeneratedTest(body, file = 'generated.js') {
  if (isJsFile(file)) {
    const { ast, error } = parseJs(body, file);
    if (!ast) return { valid: false, reason: `generated test does not parse: ${error}`, assertions: 0 };
    const assertions = jsAssertions(ast.program);
    return assertions > 0
      ? { valid: true, reason: null, assertions }
      : { valid: false, reason: 'generated test contains no assertion', assertions };
  }

  if (/\.py$/i.test(file)) {
    const detail = pythonMutationsDetailed(body, file);
    if (detail.parseError) return { valid: false, reason: `generated test does not parse: ${detail.parseError}`, assertions: 0 };
    const assertions = (body.match(/^\s*assert\b|\bpytest\s*\.\s*raises\b|self\.assert\w+\(/gm) ?? []).length;
    return assertions > 0
      ? { valid: true, reason: null, assertions }
      : { valid: false, reason: 'generated test contains no assertion', assertions };
  }

  return { valid: false, reason: 'no parser for this generated-test language', assertions: 0 };
}
