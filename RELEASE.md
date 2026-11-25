# Release notes — unfake 0.1.0

**Find the tests that cannot fail. Then fix them.**

---

## Why this exists

AI writes tests that pass. That is not the same as tests that test anything.

The tell is everywhere now. A function gets a test that asserts `typeof x === 'boolean'`. A `clamp()` gets a test that calls it and checks nothing. A component gets a test that mocks the component. The suite is green, coverage looks healthy, and none of it would notice a real bug.

The usual response is a linter that reads the test and guesses. That fails for the obvious reason: reading a test cannot tell you whether it would catch a regression. Only running the code can.

`unfake` does the thing that actually answers the question. It **breaks your source on purpose** and checks whether the suite notices. When it doesn't, it writes the test that was missing.

---

## What it does

```
$ unfake scan

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
$ unfake fix
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

`unfake` reads the comparison, resolves the threshold (including `const MAX = 10`), probes the real return values at all three points, and pins them. Verified, not assumed: the suite must still be green afterwards, and `unfake verify` re-runs the audit so you see the number move.

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

`unfake` modifies source files to run each mutation and restores each one in a `finally` block. It refuses to run at all if your suite is already failing, because every result would be meaningless. It refuses to write a fix if the suite goes red afterwards.

Run it on a clean working tree anyway. That is what git is for.

---

## Limits, stated plainly

These are not caveats buried in a README. They are the boundaries of what the tool claims.

**Object arguments are reported, not fixed.** `decideState(perception)` takes a shape, not a number. Feeding it `9, 10, 11` throws. `unfake` prints the exact comparison and the case you need to write, and says so instead of generating a broken test. On a real project this was 5 of 9 files.

**Equivalent mutants exist.** Bumping a config constant that no test should pin produces a survivor that is not a defect. The tool filters loop counters, bitwise tricks and shifts, but equivalence cannot be proven in general.

**Runs are sequential.** Mutations rewrite source, so files cannot be processed in parallel. Large repos are slow; use `--limit`.

**JS/TS is the best-covered path.** The Python, Go, Rust and Swift runners are detected and mutated, but the boundary-fixing logic has only been exercised on JS/TS projects so far.

---

## Status

Version 0.1.0. 2,207 lines, 29 tests, zero false positives when scanning itself.

The self-scan is the honest benchmark: `unfake` run against its own test suite reports `0 tests cannot fail, 0 untested edges, 0 do not check values`. A tool that flags its own healthy tests would not be worth shipping.

Not yet published publicly. The mechanism works and the numbers are real; what it needs before a public launch is a head-to-head on a few well-known open-source repos, so the first impression is evidence rather than a claim.

---

## License

MIT
