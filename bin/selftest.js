#!/usr/bin/env node
/**
 * Self-test: run the real CLI over the fixture project and pin its observable
 * behaviour, so a regression in the mutation pipeline (an operator that stops
 * firing, a judge misclassification, a cache key bug) fails CI loudly instead
 * of silently changing the report.
 *
 * Reads the `scan --json` output on stdin. The fixture is hand-built with a
 * known shape; the assertions below check structure and sanity, not exact
 * scores — exact scores would make every legitimate operator change a CI
 * failure.
 */
import { readFileSync } from 'node:fs';

const j = JSON.parse(readFileSync(0, 'utf8'));
const errs = [];

// The static pass must still see the fixture's known-empty test.
if (!Number.isInteger(j.summary?.fakeTests) || j.summary.fakeTests < 1) {
  errs.push(`summary.fakeTests is ${j.summary?.fakeTests}; the fixture has one provably empty test`);
}
if (!Array.isArray(j.findings) || j.findings.length === 0) {
  errs.push('no findings in the report');
}

// The mutation pass must have audited exactly the fixture's one source file.
const scored = (j.files ?? []).filter((f) => typeof f.score === 'number');
if (scored.length !== 1) errs.push(`expected exactly 1 scored file, got ${scored.length}`);
const file = scored[0];
if (file && (!Array.isArray(file.survivors) || file.survivors.length === 0)) {
  errs.push('survivors are not reported per file');
}
for (const sv of file?.survivors ?? []) {
  if (typeof sv.line !== 'number' || typeof sv.column !== 'number') {
    errs.push(`survivor missing line/column: ${JSON.stringify(sv)}`);
  }
}

// Mutation scores are computed, not asserted: but 0 or a suspiciously round
// number means the audit did not really run.
if (typeof file?.score !== 'number' || file.score <= 0 || file.score >= 1) {
  errs.push(`fixture score is ${file?.score}; expected a real intermediate value (audit did not run?)`);
}

if (errs.length) {
  console.error(`selftest FAILED:\n  - ${errs.join('\n  - ')}`);
  process.exit(1);
}
console.log(`selftest OK: ${scored.length} file, score ${file.score}, `
  + `${file.survivors.length} survivors, ${j.findings.length} findings, `
  + `notAudited ${j.notAudited}`);
