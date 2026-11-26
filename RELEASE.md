# Release notes — crucible 0.1.0

**Find the tests that cannot fail. Then fix them.**

---

## Why this exists

AI writes tests that pass. That is not the same as tests that test anything.

The tell is everywhere now. A function gets a test that asserts `typeof x === 'boolean'`. A `clamp()` gets a test that calls it and checks nothing. A component gets a test that mocks the component. The suite is green, coverage looks healthy, and none of it would notice a real bug.

The usual response is a linter that reads the test and guesses. That fails for the obvious reason: reading a test cannot tell you whether it would catch a regression. Only running the code can.

`crucible` does the thing that actually answers the question. It **breaks your source on purpose** and checks whether the suite notices. When it doesn't, it writes the test that was missing.

---

## What it does

```
$ crucible scan

  runner vitest (green in 632ms)
  29 source, 6 test files

Untested edges (4)
  src/ai/Brain.ts:57  untested-boundary
    threat.distance <= p.sightRange
    no test covers the edge of this comparison: flipping <= to < went unnoticed
    → Add a case where both sides are equal

Tests that cannot fail (2)
  tests/fake.test.js:10  no-assertion
    it('clamp runs')
    test runs code but never asserts anything

0 tests cannot fail, 4 untested edges, 6 do not check values
mutation score 31% across 4 files
```

Then:

```
$ crucible fix
  wrote tests/limits.exact.test.js (1 boundary comparison pinned)

1 file(s) written, suite still green.
```

What gets written:

```js
describe('limits.isFull at the MAX boundary', () => {
  it('one below the threshold (9) returns false', () => {
    assert.equal(mod.isFull(9), false);
  });
  it('exactly at the threshold (10) returns true', () => {
    assert.equal(mod.isFull(10), true);
  });
  it('one above the threshold (11) returns true', () => {
    assert.equal(mod.isFull(11), true);
  });
});
```

On the bundled fixture this takes the mutation score from **0% to 100%**.

---

## The insight that made it work

The first version of `fix` pinned the values the existing tests already produced. `isFull(5)` returns `false`, so it asserted `false`. That test looks responsible and **catches nothing** — 5 is nowhere near the threshold of 10, so `>=` and `>` behave identically there.

To kill an off-by-one you have to call **at the boundary**: 9, 10 and 11. That is the difference between a test that documents current behaviour and a test that would fail if the behaviour changed.

`crucible` reads the comparison, resolves the threshold (including `const MAX = 10`), probes the real return values at all three points, and pins them. Verified, not assumed: the suite must still be green afterwards, and `crucible verify` re-runs the audit so you see the number move.

---

## Two kinds of finding, graded honestly

A property test on a noise function legitimately survives a constant tweak. Calling that "fake" would be a lie, and a tool that cries wolf on its first real repo is a tool nobody runs twice.

| grade | meaning | examples |
|---|---|---|
| **certain** | provable by reading one line | `expect(true).toBe(true)`, no assertion, empty `catch`, mocking the unit under test, skipped test |
| **likely** | a deliberate break went unnoticed | `>=` → `>` with no edge case covering it |
| **suspect** | tests do pin values; may be intentional | range and continuity property tests |

Only the first two drive the headline count. `suspect` is listed separately and never counted as a fake test.

---

## What is supported

Runner detection is automatic, no configuration:

- **vitest**, **jest** — JS/TS
- **node:test** — JS/TS
- **pytest** — Python
- **go test**
- **cargo test**
- **swift test**

Source files are matched to tests by resolving imports, with a basename-reference fallback. A file with no covering test is reported as **untested**, which is a different problem and is deliberately not counted as a fake test.

Flags: `--json`, `--verbose`, `--no-mutation`, `--limit=N`.

---

## Safety

`crucible` modifies source files to run each mutation and restores each one in a `finally` block. It refuses to run at all if your suite is already failing, because every result would be meaningless. It refuses to write a fix if the suite goes red afterwards.

Run it on a clean working tree anyway. That is what git is for.

---

## Limits, stated plainly

These are not caveats buried in a README. They are the boundaries of what the tool claims.

**Object arguments are reported, not fixed.** `decideState(perception)` takes a shape, not a number. Feeding it `9, 10, 11` throws. `crucible` prints the exact comparison and the case you need to write, and says so instead of generating a broken test. On a real project this was 5 of 9 files.

**Equivalent mutants exist.** Bumping a config constant that no test should pin produces a survivor that is not a defect. The tool filters loop counters, bitwise tricks and shifts, but equivalence cannot be proven in general.

**Runs are sequential.** Mutations rewrite source, so files cannot be processed in parallel. Large repos are slow; use `--limit`.

**JS/TS is the best-covered path.** The Python, Go, Rust and Swift runners are detected and mutated, but the boundary-fixing logic has only been exercised on JS/TS projects so far.

---

## Does it work on real code

Run against two mature open-source projects and one sample written the way an
assistant writes tests:

| project | stars | mutation score | false positives |
|---|---|---|---|
| **chalk** | 23k | **92%** | 0 |
| **slugify** | 2.7k | **100%** | 0 |
| AI-written sample | — | **25%** | 4 findings |

The two mature projects score high because their tests are good — and `crucible`
says nothing about them. The AI-written sample is the control: six green tests
covering a small cart module, and the tool finds four real problems in it.

The score on the sample is the point. Every one of those six tests passes, and
none of them would notice a bug:

```js
it('subtotal returns a number', () => {
  assert.equal(typeof subtotal([{ price: 10, qty: 2 }]), 'number');
});
it('shipping works', () => {
  shipping(30);                    // no assertion at all
});
it('total is defined', () => {
  assert.ok(total([{ price: 10, qty: 1 }]));   // any truthy value passes
});
```

`crucible` reports the missing edge at `amount >= FREE_SHIPPING_OVER`, generates the
test at 49/50/51, and the score moves.

**One honest note on methodology.** The first version of the runner detection
guessed a test glob. chalk keeps its tests in `test/[!_]*.js`, the guessed glob
matched nothing, zero tests ran, the suite was always green, and every mutation was
reported as a survivor — a confident `0%` about a project that actually catches the
mutation. It was caught by manually breaking `index.js` and watching 30 tests fail
while `crucible` still said "survived". The runner now comes from the project's own
test script, and there are five regression tests pinning that. A wrong score is
worse than no score.

---

## Limits, stated plainly

**Boundaries on intermediate variables are reported, not fixed.** `const visible = threat.distance <= sight; if (visible && wounded) ...` cannot be probed by varying the distance: all three boundary points return the same value, because the difference only appears when other conditions also hold. `crucible` detects this, refuses to write a test that would pin three identical values, and prints the comparison for a human. On a 5k-line game prototype this was 0 of 9 files fixable — every boundary was an intermediate variable in a state machine.

**Equivalent mutants exist.** Bumping a config constant that no test should pin produces a survivor that is not a defect. The tool filters loop counters, bitwise tricks and shifts, but equivalence cannot be proven in general.

**Runs are sequential.** Mutations rewrite source, so files cannot be processed in parallel. A 9-file audit of the game prototype took 70 seconds; large repos need `--limit`.

**Xcode projects are detected but impractically slow.** A single `xcodebuild test` cycle measured 5m37s on a real project, making a 12-mutation audit take over an hour. Technically supported, practically not.

**JS/TS is the best-covered path.** Python, Go, Rust and Swift runners are detected and mutated, but the boundary-fixing logic has only been exercised on JS/TS.

**No discoverable test script means refusal, not a guess.** If the runner cannot be determined from `package.json` or a known config, `crucible` says so and stops. Guessing produced a confidently wrong `0%` score once, which is exactly the failure mode this tool exists to prevent.

---

## Status

Version 0.1.0. 2,991 lines, 64 tests. Zero false positives scanning itself, chalk and slugify.

The self-scan is the honest benchmark: `crucible` run against its own suite reports `0 tests cannot fail, 0 untested edges, 0 do not check values`.

Repository is private for now. The mechanism works and the numbers above are reproducible.

**Validated on:**

| project | stars | score | notes |
|---|---|---|---|
| chalk | 23k | 100% | 0 false positives |
| slugify | 2.7k | 100% | 0 false positives |
| AI-written cart module | — | 58% | 4 findings, all real |
| object-field sample | — | 0% → 67% | auto-fixed |
| 5k-line game prototype | — | 52% | 17 edges reported |

---

## License

MIT

---

## What changed after validation

Three upgrades, each driven by a measurement rather than a guess:
**Two profiles.** A bare tuning constant (`let maxHealth = 34`) is not a test-quality signal. Under the default `logic` profile those lines are skipped; formulas and comparisons inside declarations are still mutated, because they change behaviour. `--profile=strict` mutates everything. On the game prototype this moved a file from 25% to 58% — the earlier number was mostly counting rebalanced constants as defects.

**Five more operators.** Condition negation (`if (x)` → `if (!x)`), statement removal (`return x` → `return undefined`), and string emptying (`'full'` → `''`) alongside the existing comparison/boolean/arithmetic/number/return set. Each one targets a failure the earlier set could not see: a branch never taken both ways, a return value nobody checks, a status string no test asserts.

**Even sampling and narrowed commands.** 12 mutations are chosen by line bucket so a well-tested first half cannot hide a bare second half, and only the test files covering the source are run instead of the whole suite.

**One bug found by the upgrade itself.** The operator table had `>=`, `<=`, `==`, `===` but not bare `>` and `<`. Every `a > b` in every project had been silently unmutable since the first commit — the most common comparison in the language. Caught by a test asserting that a comparison inside a declaration is still mutated, which returned zero mutations. All scores before that fix were understated for files dominated by `>` and `<`.
