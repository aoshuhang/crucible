/**
 * Verify that a generated test actually kills the mutation it was written for.
 *
 * A green suite only proves the new test does not break anything. It does not
 * prove the missing boundary is now tested. Every targeted repair is therefore
 * re-run against its exact mutant and classified as repaired or ineffective.
 */
import { readFile } from 'node:fs/promises';
import { mutationsDetailed } from './mutate.js';
import { judgeMutation } from './judge.js';

function findMutation(mutations, target) {
  const sameLine = mutations.filter((mutation) => mutation.kind === 'comparison'
    && mutation.line === target.line
    && mutation.original === target.op);
  if (sameLine.length <= 1) return sameLine[0] ?? null;
  if (Number.isInteger(target.column)) {
    return sameLine.sort((a, b) => Math.abs(a.column - target.column) - Math.abs(b.column - target.column))[0];
  }
  return sameLine[0];
}

export async function verifyRepairs({ root, written, command, timeoutMs = 120_000 }) {
  const outcomes = [];

  for (const item of written) {
    if (!item.sourceFile || !Array.isArray(item.targets) || item.targets.length === 0) {
      outcomes.push({ ...item, status: 'unverified', verified: 0, total: 0, reason: 'this repair pins values but has no single target mutant' });
      continue;
    }

    const source = await readFile(item.sourceFile, 'utf8');
    const { mutations } = mutationsDetailed(source, item.sourceFile);
    const results = [];
    for (const target of item.targets) {
      const mutation = findMutation(mutations, target);
      if (!mutation) {
        results.push({ target, verdict: 'ERRORED', reason: 'the target mutation could not be found' });
        continue;
      }
      const result = await judgeMutation({ root, file: item.sourceFile, command, mutation, timeoutMs });
      results.push({ target, verdict: result.verdict, reason: result.reason ?? null, mutation: mutation.description });
    }

    const verified = results.filter((result) => result.verdict === 'KILLED').length;
    const total = results.length;
    outcomes.push({
      ...item,
      status: verified === total ? 'repaired' : verified > 0 ? 'partial' : 'ineffective',
      verified,
      total,
      results,
      reason: verified === total ? null : 'the generated test did not kill every target mutation',
    });
  }

  return outcomes;
}
