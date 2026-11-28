# crucible

> **Status: 0.4.0, early.** Built and tested against six real projects on macOS.
> A score is labelled `complete` or `sampled`, and a generated test is only
> `repaired` after its target mutation is killed. When crucible cannot determine
> something it refuses and says why, because a wrong test-quality score is worse
> than no score. Windows is exercised in CI but still experimental (see
> [Platforms](#platforms)). See [CHANGELOG.md](CHANGELOG.md). Counter-examples and
> bug reports are genuinely useful.

**Find the tests that cannot fail. Then fix them.**

AI writes tests that pass. That is not the same as tests that test anything.
`crucible` breaks your source on purpose, checks whether your suite notices, and
when it doesn't, writes the test you were missing.

```bash
crucible check     # 0.1s — read the tests, find the ones that cannot fail
crucible scan      # slower — break the source, find untested boundaries
crucible fix       # write the boundary tests that were missing
```

Works on any project with a test suite. No config file, no account. The npm
package has one runtime dependency (`@babel/parser`) for real JS/TS/JSX syntax;
Python analysis uses the interpreter's own standard-library AST.

---

## Install

**Nothing installed, run it now:**

```bash
npx @hsaohuang/crucible check
```

The package is scoped because the unscoped name `crucible` is held by an unrelated
author on npm. After installing, the command is plain `crucible`.

**Or install globally:**

```bash
npm install -g @hsaohuang/crucible
crucible check
```

**Bleeding edge, straight from this repo** (no npm publish required):

```bash
npx github:aoshuhang/crucible check
```

**From source:**

```bash
git clone https://github.com/aoshuhang/crucible
cd crucible
npm link          # puts `crucible` on your PATH
crucible check ~/code/my-project
```

Requires Node 20 or newer. Python projects need `python3` (or `python` on
Windows, or `CRUCIBLE_PYTHON`) and pytest; no Python packages are installed by
crucible.

### As an agent skill

`crucible` ships a skill so a coding agent notices it without being told:

```bash
npx @hsaohuang/crucible install
```

That copies `skills/crucible/SKILL.md` into every agent it finds —
`~/.config/opencode/skills/crucible` and `~/.claude/skills/crucible` — and says
which ones it skipped. Run it again after upgrading: a skill that lags one release
behind keeps telling the agent about flags that changed, and nothing in the agent's
answers says why.

Then "check my tests" or "are these tests real" triggers it.

From a checkout, link it instead, so your edits reach the agent:

```bash
ln -s "$PWD/skills/crucible" ~/.config/opencode/skills/crucible   # OpenCode
ln -s "$PWD/skills/crucible" ~/.claude/skills/crucible            # Claude Code
```

`crucible install --dir=PATH` writes the skill somewhere else. `--force` replaces a
copy you edited by hand; without it, a differing copy is reported and left as is.

---

## 30 seconds on a real project

```bash
$ cd ~/code/my-project
$ crucible check

  crucible check  ~/code/my-project
  1 test files, 1 source files (no tests executed)

  Cannot fail (1)
    test/cart.test.js:4  no-assertion
      it('clamp runs')
      → assert on the result, or delete the test

  Worth a look (1)
    test/cart.test.js:5 type-only

  1 test cannot fail, 1 to review
```

Exit code is 1 when something certainly cannot fail, so it drops straight into a
pre-commit hook or a CI step.

`Cannot fail` means provable by reading one line. `Worth a look` means it might be
intentional — a property test, a smoke test — and is never counted against the
suite.

---

## The problem

A test that cannot fail is worse than no test, because it looks like coverage.

```js
// This test passes. It also passes if isFull is deleted.
test('isFull returns a boolean', () => {
  assert.equal(typeof isFull(5), 'boolean');
});

// This one never runs an assertion at all.
test('clamp runs', () => {
  clamp(5, 0, 10);
});
```

Both are green. Neither would notice a real bug. This is what AI generates by
default, because "tests pass" is the only signal it optimises for.

## How crucible knows

It does not read your tests and guess. It **changes your code and sees whether the suite notices.**

```js
export function isFull(count) {
  return count >= MAX;        // crucible flips this to `>`
}
```

If the suite is still green, that comparison is not covered at its edge. That is not an opinion — it is an observation, and the tool restores your file byte-for-byte afterwards.

## What it reports

```
crucible ~/projects/game

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

Tests that do not check values (6)
  ...

0 tests cannot fail, 4 untested edges, 6 do not check values
sampled mutation score 31% across 4 files · 48/611 mutants
This is a sample. For a complete gate run: --select=all --limit=all --mutations=all.
```

## What it fixes

`crucible fix` writes a test that calls at the exact threshold and its neighbours:

```js
// generated by crucible
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

Pinning `isFull(5)` looks responsible and catches nothing — 5 is nowhere near the
threshold, so `>=` and `>` behave identically. Calling at 9, 10 and 11 is what
makes an off-by-one fail.

It verifies before claiming. First, the suite must still be green after writing.
Then `fix` replays each target mutation: the generated boundary is only reported
as `repaired` when that exact mutant is killed. A green suite alone is reported as
unproven, never as a successful repair. `crucible verify` re-runs the audit for
the overall score.

## Two kinds of finding, graded honestly

A property test on a noise function legitimately survives a constant tweak. Calling
that "fake" would be a lie, so findings are graded:

| grade | meaning | example |
|---|---|---|
| **certain** | provable by reading one line | `expect(true).toBe(true)`, an empty test, mocking the only local module under test |
| **likely** | a deliberate break went unnoticed | `>=` → `>` in a comparison with no edge case |
| **suspect** | may be intentional | a property test, an explicit no-throw smoke test, a test skipped because an external service is unavailable |

Only the first two drive the headline count. `suspect` is listed separately and
never counted as a fake test. In particular, an intentionally skipped integration
test is not treated as a certain defect.

## Commands

| command | speed | what it does |
|---|---|---|
| `crucible check [path]` | **0.1s** | reads the test files, finds the ones that cannot fail. No tests are executed. |
| `crucible scan [path]` | seconds–minutes | mutates the source, finds boundaries no test covers |
| `crucible fix [path]` | seconds | attempts the missing boundary tests, then replays each target mutation |
| `crucible verify [path]` | seconds–minutes | re-runs `scan` after a fix, to see the score move |
| `crucible install` | instant | copies the agent skill into OpenCode and Claude Code |

`[path]` is a directory or a single file. `crucible scan src/cart.js` audits only
that file, in the project that owns it. On a second run over unchanged files the
incremental cache makes `scan` near-instant.

`check` is the one you run while writing tests. `scan` is the one you run before a
PR. `fix` is what you run when `scan` finds something.

### Flags

| flag | applies to | effect |
|---|---|---|
| `--json` | all | machine-readable output, including `next`, `sampling`, `scoreKind` and per-file `survivors` |
| `--limit=N\|all` | scan, fix | audit at most N source files (default 12); `all` removes the cap; partial runs name what was left out |
| `--mutations=N\|all` | scan | sample at most N mutants per file (default 12); `all` runs every generated mutant |
| `--select=MODE` | scan | file selection: `files` (default), `changed`, `risk`, `all` |
| `--jobs=N` | scan | parallel sandbox workers (default `min(4, cpus)`; `1` mutates in place) |
| `--no-cache` | scan | ignore the incremental results cache |
| `--fail-under=N` | scan | exit 1 when the mutation score is below N percent |
| `--verbose` | scan | print each mutation as it runs |
| `--no-mutation` | scan | static checks only, no test runs |
| `--profile=logic\|strict` | scan | skip tuning constants (default) or mutate everything |
| `--allow-env-noise` | scan | audit even when the runner exits on an environment error |
| `--force` | fix, install | overwrite a generated test file, or a skill copy, that was edited by hand |
| `--dir=PATH` | install | copy the skill here instead of the detected agent directories |

### Exit codes

`check` and `scan` exit 1 when something is certainly wrong — including a mutation
score below `--fail-under` — and 2 when the audit could not run at all (no runner,
red suite). A sampled score's gate message always states the audited files and
mutants; for a release gate use `--limit=all --mutations=all` to obtain
`scoreKind: "complete"`. A parse failure, errored mutant or skipped file prevents
a complete label; `sampling.filesIncomplete` says how many files were affected. That is all a pre-commit
hook or a CI step needs:

```bash
# .git/hooks/pre-commit
#!/bin/sh
npx @hsaohuang/crucible check || {
  echo "Some tests cannot fail. Fix them, or commit with --no-verify."
  exit 1
}
```

## Supported runners

Detected automatically, no configuration:

- **vitest**, **jest** (JS/TS)
- **node:test** (JS/TS)
- **ava**, **mocha**, **tap** (JS/TS, via the project's test script)
- **pytest** (Python)
- **go test**
- **cargo test**
- **swift test**

`scan` works on all of them, and narrows the test command to the covering files
for vitest, jest, ava, `node --test`, pytest, Go and Cargo, preserving the
project's config/build flags. Unknown flags fall back to the full command rather
than silently changing the environment. `fix` writes JS/TS (including TypeScript
boundary tests, which run through the project's own runner) and pytest code; the
others are detected and mutated but their repair still needs a hand-written test.
CommonJS modules can be audited but are not auto-fixed. `check` analyses
JavaScript/TypeScript test bodies and Python `def test_*` functions.

Source files are matched to tests by resolving imports (including tsconfig path
aliases and workspace packages), by Python package/`src` layout, by Go package
tests and by Rust's `tests/*.rs` convention. Imported barrel/package entries are
followed transitively, so a test of `src/index.ts` covers the modules it loads.
A basename mention is shown only as an unverified hint. A file with no covering
test is reported as *untested*, which is a different problem and is not counted
as a fake test. Test support, examples, sample apps, benchmarks and docs are not
treated as product source.

**Monorepos.** A workspace root usually declares packages but does not have the
runner installed itself. `scan` detects npm/yarn workspaces and
`pnpm-workspace.yaml`, and prints the package directories to run against instead of
blaming the runner. Run `crucible scan packages/web` per package for full coverage.

**Formats it cannot parse.** `.astro`, Ruby, PHP and similar files are counted
and reported as skipped. They are not silently treated as clean. `.vue` and
`.svelte` are different: their `<script>` block IS JavaScript, so `check` reads
it and reports findings inside it; `scan` still cannot mutate them.

If the test command cannot be determined from `package.json` or a known config
file, crucible refuses rather than guessing a glob. A guessed glob matches nothing,
runs zero tests, and reports every mutation as a survivor — a confident `0%` about
a healthy project.

## Safety

`crucible` modifies your source files to run each mutation, and restores each one in
a `finally` block. Guarantees:

- It refuses to run if your suite is already failing, because every result would be
  meaningless.
- It refuses to write a fix if the suite goes red afterwards.
- If a restore ever fails (disk full, permissions changed mid-run), the run exits 2,
  the failure is printed, and the original content is written next to the file as
  `<file>.crucible-backup`. A restore failure is never silent.

Run it on a clean working tree anyway — that is what git is for.

## Does it work on real code

`crucible check` run against six real projects. The number that matters is the
middle column: how many tests it wrongly accuses.

| project | test files | **false positives** | flagged for review |
|---|---|---|---|
| **axios** | 185 | **0** | 159 |
| **express** | 92 | **0** | 18 |
| **lodash** | 6 | **0** | 84 |
| **p-map** | 1 | **0** | 0 |
| **chalk** | 8 | **0** | 0 |
| **slugify** | 1 | **0** | 0 |
| a known-bad sample | 1 | — | 3 |

Zero false positives on 293 test files is the claim this tool lives or dies on. It
took six rounds of running against real repositories to get there — the first
version reported 282 problems in p-map alone, all of them well-written ava tests.

The known-bad sample is the control: one test that calls `clamp()` and asserts
nothing, correctly reported.

The 0.4 audit added larger, structurally different projects:

| project | test files | **certain findings** | what they are |
|---|---|---|---|
| **NestJS** | 695 | **1** | one upstream test calls `publish()` and asserts nothing |
| **Vue** | 208 | **2** | one assertion is commented out; one test only constructs components |
| **Flask** | 27 | **0** | — |
| **Django** | 653 | **0** | after fixing Python docstring/Unicode masking and TestCase helpers |
| **Click** | 43 | **0** | Python pytest |
| **FastAPI** | 567 | **0** | tutorial wrapper/helper delegation recognised |
| **Zod** | 205 | **9** | 5 empty placeholders + 4 literal tautologies, all real upstream |
| **React** | 597 | **4** | one empty test + three literal placeholders, all real upstream |
| **SQLAlchemy** | 241 | **2** | one pass-only placeholder + one query smoke test |
| **Gin** | 40 | **0** | Go-only project; discovery and mutation scan verified |
| **Next.js snapshot** | 858 | **0** | partial snapshot used for parser stress only |

Real-project runs found and fixed repeated false-positive classes: awaited promise
assignments, TypeScript `@ts-expect-error`/`satisfies` assertions, nested
test-named route handlers, collaborator mocks, custom test decorators, Python
docstring/Unicode masking, Django TestCase helpers, Go build-tag-excluded files
and non-asserting unittest smoke tests. Those cases are regression tests now.

Mutation scans were also exercised on axios, Express, Lodash, NestJS, Flask, Gin,
Click and FastAPI. The real projects are pinned in
`.github/workflows/real-projects.yml`; the large static job covers NestJS, Vue,
Django, Flask, Click, FastAPI and Zod.

`scan` also produces a mutation score on the slow path. Those runs are samples
unless `--mutations=all` is passed; the report and JSON state `scoreKind` and how
many files and mutants were audited. chalk scored 92% sampled (94% full), slugify
91%, and a 5k-line game prototype 52%.

Full methodology, including the two occasions this tool reported a number that
flattered the suite, is in [RELEASE.md](RELEASE.md).

## For coding agents

Two things make it usable by an agent rather than only by a human.

**A skill, so the agent notices it.** `skills/crucible/SKILL.md` ships in the repo.
Install it by symlinking into your agent's skill directory:

```bash
ln -s "$PWD/skills/crucible" ~/.config/opencode/skills/crucible   # OpenCode
ln -s "$PWD/skills/crucible" ~/.claude/skills/crucible            # Claude Code
```

**A machine-readable plan, so the agent knows what to do.** `--json` carries an
ordered `plan` and a `next` block on every finding:

```json
{
  "plan": {
    "steps": [
      { "order": 1, "action": "run_command", "command": "npx @hsaohuang/crucible fix \"/repo\"" },
      { "order": 2, "action": "verify", "command": "npx @hsaohuang/crucible scan \"/repo\" --json" }
    ],
    "doNotClaim": [
      "that the tests are real without re-running scan",
      "that 3 suspect findings are defects — they may be intentional property tests"
    ]
  },
  "findings": [{
    "id": "no-assertion",
    "file": "test/cart.test.js",
    "line": 10,
    "confidence": "certain",
    "next": {
      "kind": "edit_test",
      "file": "test/cart.test.js",
      "line": 10,
      "instruction": "Add an assertion to the test at test/cart.test.js:10, or delete the test if it covers nothing."
    }
  }]
}
```

The `doNotClaim` list exists because an agent will otherwise report "tests are now
real" after running `fix`, without checking whether the score moved.

## Two profiles

A tuning constant is not a test-quality signal. `let maxHealth = 34` should not
require a test that fails when you rebalance the game.

```
crucible scan --profile=logic    # default: skip bare constant declarations
crucible scan --profile=strict   # mutate everything, including constants
```

`logic` still mutates formulas (`let speed = 5.6 + 0.4 * (size - 1)`) and
comparisons inside declarations, because those change behaviour. It only skips
lines whose right-hand side is a single literal.

## Operators

| kind | example | catches |
|---|---|---|
| comparison | `>=` → `>` | off-by-one at a threshold |
| condition | `if (x)` → `if (!x)` | a branch never taken both ways |
| boolean | `&&` → `\|\|` | wrong logical connective |
| statement | `return x` → `return undefined` | a return value nobody checks |
| return | `return true` → `return false` | inverted result |
| string | `'full'` → `''` | a status string no test asserts |
| arithmetic | `+` → `-` | wrong operator in a formula |
| number | `34` → `35` | an unpinned computed value |

## Speed

Four things keep it usable:

- **Only covering tests run.** If a source file has 2 covering test files, the
  command is narrowed to those instead of the whole suite. This works for
  vitest, jest, ava, `node --test`, pytest, Go and Cargo.
- **Sampling covers the whole file.** 12 mutations are chosen by line bucket, not
  by taking the first 12 matches, so a well-tested first half cannot hide a bare
  second half.
- **Parallel sandboxes.** With `--jobs=N` (default `min(4, cpus)`) crucible copies
  the project into temporary sandboxes and mutates them independently. Each copy
  must run the suite green once before any result from it is trusted; otherwise the
  audit falls back to mutating in place, sequentially. `--jobs=1` forces that path.
- **Incremental cache.** Results are keyed by the source bytes, covering-test
  bytes, every source/test in the project (conservative transitive-dependency
  invalidation), lockfiles, TypeScript config, test-runner config, runner command,
  profile, mutation cap, Node version and platform. The cache lives in
  `node_modules/.cache/crucible` (or the OS temp directory when there is no
  `node_modules`) and never in the repo root. `--no-cache` ignores it.

A 9-file audit of a 5k-line TypeScript game prototype took 70 seconds sequentially;
the sandbox path scales with cores, and a second run over unchanged files does no
mutation work at all.

## What it cannot fix, and says so

A boundary comparison is only auto-fixed when a probe can **observe** it.

```js
// Fixed: the comparison IS the return value.
export function canEnter(actor) { return actor.level >= 5; }

// Not fixed: the comparison feeds an intermediate variable that several branches
// consume. Probing 14/15/16 all return 'wander', because the real difference only
// appears when other conditions also hold.
const visible = threat.distance <= p.sightRange;
if (visible && p.healthFrac < 0.3) return 'flee';
```

In the second case `crucible` refuses to write the test. Writing it would pin three
identical values — a green test that cannot fail, which is the exact defect this
tool exists to find. It prints the comparison and the case a human needs instead.

On a real project (a 5k-line game prototype) this split was 0 of 9 files fixable:
every boundary was an intermediate variable in a state machine. That is an honest
result, not a failure — the report still names all 5 untested edges with the exact
expression.

## Platforms

| platform | state |
|---|---|
| macOS | developed and tested here |
| Linux | tested in CI on Node 20, 22 and 24 |
| Windows | **experimental.** CI runs the suite and reports it without gating. Shell quoting and sandbox symlinks are the likely rough edges; an issue either way is useful. |

Node 20 or newer. No other requirements.

## When it does not work

| symptom | what it means |
|---|---|
| `no test runner detected` | the test command is not in `package.json`, and no known config file was found. Say how the project runs its tests in an issue — guessing a glob is how the tool reports `0%` about a healthy suite. |
| `dependencies are not installed` | run the install step the message names (`pnpm install`, `pip install -e .`, …) |
| `environment error` | the tests pass but the runner exits non-zero — a missing browser, an unreachable host. The message names the fix. |
| `suite is red` | real test failures. Fix them first; mutation results would be meaningless. |
| `file is not writable` | that source file was skipped. Nothing was changed. |
| score looks too low | run with `--profile=strict` to include tuning constants, and check `--limit` covered the files you care about. |
| `ENOVERSIONS No versions available` | the project's `.npmrc` sets `min-release-age`, which refuses packages published too recently. express ships one with `min-release-age=7`. Either wait, or add `--min-release-age=0` to the npx call. |
| `EALLOWGIT Fetching packages of type git` | the registry or `.npmrc` disables git dependencies. Use the npm package instead of `npx github:...`. |

If a report looks wrong — a test you know is fine gets flagged — that is the most
valuable bug you can file. Include the test file and the command output.

## Limits, stated plainly

- **Boundaries on intermediate variables are reported, not fixed.** See above.
- **Complex numeric signatures are not auto-fixed.** A threshold that is another
  function parameter (`clamp(n, lo, hi)`) cannot be resolved from the source alone.
  `fix` names those unresolved edges as manual work instead of pretending the file
  is fully repaired.
- **Equivalent mutants exist.** Bumping a config constant that no test should pin
  produces a survivor that is not a defect. The tool filters loops, bitwise tricks
  and shifts, but it cannot prove equivalence in general.
- **Go build constraints are evaluated for the current machine.** Files excluded
  by their `//go:build` expression are not mutated. Custom tags passed through
  `-tags` are not guessed, so a tag-specific CI build should be audited with that
  build's environment.
- **Basename-only coverage is a hint, not a score.** Modern aliases, workspaces,
  Python src layouts, Go siblings and Rust integration tests are resolved. A bare
  name mention in executable code is reported separately and never drives mutation
  scores.
- **Parallelism needs a copyable project.** Sandbox mode copies the tree (excluding
  `node_modules` and `.git`) and links dependencies. A project whose tests depend on
  `.git`, absolute paths, or writing into the repo may behave differently in a
  sandbox; crucible falls back to the in-place sequential path when a copy cannot be
  validated. A large repo is still slow; use `--limit` to audit the files you care
  about.
- **Xcode projects are detected but impractically slow.** One `xcodebuild test`
  cycle measured 5m37s, so a 12-mutation audit takes over an hour. Use it on a
  single file at most, or not at all.
- **No discoverable test script means refusal, not a guess.** A wrong score is worse
  than no score.
- **CommonJS modules are scanned but not auto-fixed.** `fix` recognises ESM and
  module-level Python functions; a file that only assigns `module.exports` is
  audited normally but gets no generated test. Write that one by hand, or convert
  it to ESM. Python class methods are likewise reported but not auto-fixed.

## When the suite fails for a reason that is not your code

Four states, not two:

| state | meaning |
|---|---|
| green | suite passed, results are trustworthy |
| suite is red | tests fail; fix them first, mutation results would be meaningless |
| environment error | tests pass but the run exits non-zero — a missing browser, an unreachable host, an unloadable native addon |
| runner not found | dependencies are not installed, or the binary is missing |

The environment case is worth naming because it looks like a failure and is not.
axios is the reference: 2554 tests pass and vitest exits 1 because Playwright's
Firefox and WebKit binaries are absent.

```
runner vitest (environment error)
the tests themselves passed, but the run failed for an environment reason:
a browser binary is missing. Run `npx playwright install`, then try again.
Re-run with --allow-env-noise to audit anyway.
```

`--allow-env-noise` proceeds and marks the report, so a low score from tests that
never started is not mistaken for a weak suite.

The check is strict: passing tests, no failing tests, and a recognised error class.
`0 passed` does not count — an environment error over a suite that never ran could
hide real failures.

## License

MIT
