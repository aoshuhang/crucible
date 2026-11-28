/**
 * Turn findings into next steps an agent can act on.
 *
 * A report that says "assert the exact value" still requires the reader to work out
 * what to do, where, and in what order. For a human that is fine — they have the
 * file open. For an agent it is an extra reasoning step that it may get wrong.
 *
 * So each finding carries a `next` block: either a command to run, or a concrete
 * edit to make. The agent does not have to interpret the finding, only execute it.
 */

/** Finding ids that `crucible fix` can handle on its own. */
const AUTO_FIXABLE = new Set(['untested-boundary']);

/** Finding ids whose repair is deleting or rewriting the test itself. */
const EDIT_TEST = new Set([
  'no-assertion',
  'always-true',
  'assert-true-literal',
  'empty-catch-in-test',
  'mock-self',
  'skipped',
]);

/** Finding ids that are one substitution away from being real. */
const STRENGTHEN = new Set(['type-only', 'truthy-only', 'not-null-only']);

/**
 * @param {object} finding
 * @param {{ root: string }} context
 * @returns {{ kind: string, command?: string, file?: string, line?: number, instruction?: string }}
 */
export function nextStepFor(finding, context) {
  if (AUTO_FIXABLE.has(finding.id) || AUTO_FIXABLE.has(finding.kind)) {
    return {
      kind: 'run_command',
      command: `npx @hsaohuang/crucible fix ${JSON.stringify(context.root)}`,
      instruction: 'Attempts to write the boundary test. It may refuse when the edge is not observable. Treat the repair as unproven until fix reports the target mutation as killed and scan confirms the score moved.',
    };
  }

  if (EDIT_TEST.has(finding.id)) {
    return {
      kind: 'edit_test',
      file: finding.file,
      line: finding.line,
      instruction: finding.id === 'no-assertion'
        ? `Add an assertion to the test at ${finding.file}:${finding.line}, or delete the test if it covers nothing.`
        : finding.id === 'skipped'
          ? `Re-enable or delete the skipped test at ${finding.file}:${finding.line}.`
          : finding.id === 'mock-self'
            ? `Stop mocking the module the test imports at ${finding.file}:${finding.line}; mock its collaborators instead.`
            : `Replace the assertion at ${finding.file}:${finding.line} with one that checks the actual value.`,
    };
  }

  if (STRENGTHEN.has(finding.id)) {
    return {
      kind: 'strengthen_assertion',
      file: finding.file,
      line: finding.line,
      instruction: `At ${finding.file}:${finding.line}, replace the type or truthiness check with an assertion on the concrete value. Run the code once to see what it returns, then pin that.`,
    };
  }

  return {
    kind: 'review',
    file: finding.file,
    line: finding.line,
    instruction: `Inspect ${finding.file}:${finding.line}; the tool cannot prove this one is a defect.`,
  };
}

/**
 * A single ordered plan for the whole run.
 *
 * Agents follow instructions better than they prioritise lists, so this says what
 * to do first and what not to claim.
 *
 * @param {object} opts
 * @param {object[]} opts.findings
 * @param {object} opts.summary
 * @param {boolean} opts.suiteGreen
 * @param {string} opts.root
 */
export function planFor({ findings, summary, suiteGreen, root }) {
  const certain = findings.filter((f) => f.confidence === 'certain');
  const likely = findings.filter((f) => f.confidence === 'likely');
  const autoFixable = findings.filter((f) => AUTO_FIXABLE.has(f.id) || AUTO_FIXABLE.has(f.kind));
  const steps = [];

  // `false` means the suite ran and is red. `null` means it was never run
  // (static-only). Telling an agent to "fix the failing suite" when nobody ran it
  // sends it chasing a failure that does not exist.
  if (suiteGreen === false) {
    steps.push({
      order: 1,
      action: 'fix the failing suite first',
      why: 'mutation results are meaningless while the suite is red',
    });
    return { steps, doNotClaim: ['that the suite is healthy', 'any mutation score'] };
  }

  if (autoFixable.length > 0) {
    steps.push({
      order: steps.length + 1,
      action: 'run_command',
      command: `npx @hsaohuang/crucible fix ${JSON.stringify(root)}`,
      why: `${autoFixable.length} boundary finding${autoFixable.length === 1 ? '' : 's'} may be auto-fixable; fix will refuse an edge it cannot observe and verifies each target mutation it writes for`,
    });
  }

  if (likely.length > 0) {
    steps.push({
      order: steps.length + 1,
      action: 'write_missing_tests',
      why: `${likely.length} deliberate break${likely.length === 1 ? '' : 's'} went unnoticed; each one names the untested expression`,
    });
  }

  if (certain.length > 0) {
    steps.push({
      order: steps.length + 1,
      action: 'strengthen_or_delete_weak_tests',
      why: `${certain.length} test${certain.length === 1 ? '' : 's'} cannot fail at all; fix the assertions or remove the tests`,
    });
  }

  steps.push({
    order: steps.length + 1,
    action: 'verify',
    command: `npx @hsaohuang/crucible scan ${JSON.stringify(root)} --json`,
    why: 'the score must move; do not report success without it',
  });

  const doNotClaim = [
    'that the tests are real without re-running scan',
    `that ${summary.worthChecking} suspect findings are defects — they may be intentional property tests`,
    'that a generated file repaired a survivor solely because the suite stayed green — the target mutation must be killed',
  ];
  if (suiteGreen === null) {
    doNotClaim.push('any mutation score — no tests were executed in this run');
  }

  return { steps, doNotClaim };
}
