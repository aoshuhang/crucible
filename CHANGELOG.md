# Changelog

All notable changes to crucible. Versions follow semver; anything before 1.0 may
still change behaviour in a minor release.

## 0.4.0 — 2026-11-28

Trustworthy results: real parsers, verified repairs and honest scores.

### Fixed after auditing large real projects

Real-project runs covered axios, Express, Lodash, NestJS, Flask, Gin, Vue, Django,
Click, FastAPI, Zod, React, SQLAlchemy and a Next.js snapshot. These findings
changed the tool:

- Python test discovery no longer treats a Flask route handler named
  `def test_index()` inside a test as a pytest test. Python masking now handles
  triple-quoted docstrings and preserves UTF-16 indices for emoji; Django findings
  were previously shifted by 100 lines after an emoji string.
- Django helper classes named `test_func()` and pytest collection rules are
  respected: only top-level classes that look like TestCase/Test containers are
  scanned. Assertions delegated via `self._test_*`, `super().test_*`, local
  helpers and custom decorators are recognised. Module-level `test_*` helpers in
  unittest/Django files are not treated as pytest tests, and a unittest class
  method with no direct assertion is `suspect` because it may rely on setUp or a
  base class. FastAPI tutorial wrapper tests that call an imported `test_*` helper
  are recognised as delegated assertions; explicit `Just for coverage` calls are
  classified as smoke tests.
- A `.rejects`/`.resolves` assertion assigned to a variable and awaited later is
  no longer reported as un-awaited.
- `@ts-expect-error`, `satisfies`, `expectTypeOf` and `assertType` count as
  TypeScript compile-time assertions.
- A test that only calls a validation method such as `parse`, `safeParse` or
  `validate` to verify success is a smoke test (`suspect`), not a certain fake
  test. Zod contained dozens of such legitimate cases.
- `mock-self` only fires for the unambiguous case: the test imports exactly one
  local module and mocks that module. Mocking one of several local modules, or an
  external package, is a collaborator mock.
- Tests whose name/comment explicitly says "does not throw/error/warn" are smoke
  tests, not certain fake tests. Imported assertion helpers (`expectMarkupMismatch`,
  `expectConsoleErrorDev`, SQLAlchemy's `eq_`/`is_`), `beforeEach` local helpers,
  JSX expression-bodied tests and `@gate`/`testFn` test-factory semantics are
  recognised.
- A multi-line Python decorator block (`@testing.skip_if(...)`) is considered when
  deciding whether a test is skipped.
- Intentionally skipped tests are `suspect`, not `certain`; they remain visible
  but no longer fail a CI gate. A placeholder inside `describe.skip` is not also
  reported as no-assertion.
- Coverage follows transitive internal imports and package/barrel entries
  (`require('../')`, `from flask import ...`, workspace packages).
- All non-test `.go` files in a package count as covered by that package's tests.
- Test support, examples, sample apps, integration fixtures, benchmarks, docs,
  `docs_src` tutorials and tool configs are excluded from product-source
  candidates.
- `--limit=N` counts files with actual mutation candidates, so a re-export-only
  `index.js` cannot consume the only slot. `fix` follows the same rule.
- `fix --json` reports per-file `skipped[]` reasons and returns a `review` next
  step when no automatic repair was written; it no longer says "nothing to fix"
  when the real limitation is CommonJS or an unobservable edge.
- Go mutation skips files excluded by the current `//go:build` expression, so a
  file such as Gin's `binding_nomsgpack.go` cannot produce phantom survivors.
- Host-platform guards (`os.name == "nt"`, `sys.platform`, `process.platform`,
  `typeof window`, ...) are not promoted to business boundaries. Their survivors
  remain `suspect`, but a macOS run no longer calls an unreachable Windows branch
  a likely untested edge.
- A Go module download timeout (`go: downloading` + `i/o timeout`/proxy error) is
  classified as missing dependencies with a GOPROXY hint, not as a red test suite.

### Fixed — mutation correctness

- JS/TS/JSX now mutate real AST nodes via `@babel/parser`. A quoted word in a
  trailing comment can no longer produce a guaranteed survivor, and every
  selected mutant is parsed before it is run.
- Python mutation uses the interpreter's `ast`/`tokenize` through
  `src/python_ast.py`; comparisons, `and`/`or`/`not`, booleans, returns, numbers
  and strings are mutated without touching comments, docstrings or imports.
- Narrowed vitest/jest/ava commands preserve `--config`, `--environment` and every
  other project flag instead of rebuilding a stripped command. Unknown flags fall
  back to the full command rather than guessing. Go/Cargo nesting preserves
  `-race`, build tags, features and package flags.
- Python `--profile=strict` reaches the AST helper; it previously always used the
  logic profile.
- A source file that cannot be parsed is reported as unaudited, with the parser
  error, rather than looking clean.
- Large-file mutation avoids an O(n²) line-index rebuild.

### Fixed — repairs are verified, not assumed

- Every generated test must parse and contain at least one assertion before it is
  written. Object-valued boundaries now get a deep assertion; they used to become
  comment-only tests.
- Titles, imports and values containing apostrophes/quotes are escaped. Python
  boundary cases require three representable observations with distinct
  outcomes, and generated function names are unique. Two boundaries in the same
  JavaScript function now get distinct output files instead of overwriting.
- `fix` replays each generated boundary's target mutation after the suite goes
  green. JSON and human output classify repairs as `repaired`, `partial`,
  `ineffective` or `unverified`; only a killed target counts.
- Unresolvable numeric edges are printed as manual work instead of being silently
  omitted.

### Fixed — honest coverage and cache

- Test-to-source coverage now uses AST imports, `tsconfig`/`jsconfig` path
  aliases and workspace package names. Python `src/` layouts and Rust
  `tests/*.rs` integration tests resolve correctly.
- Basename-only mentions are reported as unverified hints and never drive the
  mutation score; comments and fixture strings no longer look like coverage.
- The cache is invalidated by every source/test in the project, lockfiles,
  tsconfig, runner config, Node version and platform, so a changed indirect
  dependency cannot re-use a stale score.

### Fixed — score scope

- Scores carry `scoreKind: "complete" | "sampled"` and a `sampling` block with
  files and mutant counts.
- `--limit=all`, `--mutations=all` and `--select=files|changed|risk|all` support
  explicit complete audits and useful partial priorities.
- `--fail-under` messages state when a passing or failing gate only covered a
  sample. Numeric threshold survivors use the honest `untested-threshold` id and
  report the real change (`bump 5 to 6`) instead of a comparison flip.

## 0.3.0 — 2026-11-27

Score honesty, agent-visible results, and loud failures. Every fix below was
found by adversarial probing of the tool itself and has a regression test.

### Fixed — the score can no longer be inflated

- Syntax-broken mutants are no longer counted as killed. The line-based operator
  scanner used to read `x => x * 2` as `=` + `>` and emit `x =>= x * 2`, TS
  generics and JSX angle brackets as comparisons, and shifts (`x << 2`) as
  `<<` + a stray `>`. Those mutants fail to parse, the suite goes red for
  reasons unrelated to test quality, and the run was counted as KILLED. On a
  suite with zero assertions this alone produced a score of 18%. Fixes:
  - comparison operators now require operand-shaped text on both sides (arrow
    heads, generics, shifts and JSX no longer match);
  - the masker runs over the whole file, so the continuation lines of block
    comments and template literals (SQL in a backtick string) are never mutated;
  - regex literals (`/-/g`) are recognised and never read as division;
  - plain-JS mutants are parse-checked with `new Function` (compile-only) before
    they are scheduled; TS files keep the runtime classification;
  - a failed run whose output looks like a parse error (`SyntaxError`, …) is
    classified ERRORED, not KILLED, for every runner.
- A zero-assertion suite now scores 0. This is the headline honesty property.
- The mutation score no longer claims files it did not audit: `--limit` runs
  state the limit and the number of covered files that were left out, in both
  the human report (`N covered files were not audited (over --limit=12)`) and
  the JSON (`limit`, `notAudited`).

### Fixed — survivors are visible again

- Every surviving mutation is now a finding. Non-boundary survivors (arithmetic
  flips, emptied strings, dropped returns) used to vanish from the report: a
  suite whose only gap was `*` → `/` showed zero findings, exit 0, and a JSON
  `findings` array an agent had no reason to distrust. They are graded
  `suspect` — real gaps most of the time, possibly equivalent mutants — so they
  never drive the headline count or the exit code.
- The JSON per-file entries now carry a `survivors` list (line, column, kind,
  description) so an agent can act without re-running anything.
- Boundary findings carry a `column`; two comparisons on one line are two
  findings with distinct descriptions (`count >= MAX` vs `weight >= 5`) instead
  of one collapsed duplicate.

### Fixed — safety

- A file that could not be restored after mutation is now reported on every exit
  path (signal, normal exit, crash), the original content is written next to it
  as `<file>.crucible-backup`, and the run exits 2. Previously the restore
  failure was swallowed (`.catch(() => {})`), the user's file was left mutated,
  and the process exited 0.
- Sandbox validation runs the suite in ONE copy instead of N: the copies are
  byte-identical and share the linked `node_modules`, so N-1 of those runs
  proved nothing and cost minutes on slow suites.

### Fixed — interface

- `fix --json` prints a machine-readable report. It used to print nothing at
  all — every message went through the human-only `say()` — while the README
  promised JSON for every command.
- Shell quoting uses single quotes (`shQuote`). `JSON.stringify` produces double
  quotes, inside which the shell still expands `$(…)` and backticks; a test file
  named `$(touch pwned).test.js` would have executed its name.
- The results cache key includes the package version. 0.2.0 changed the judging
  rules while the cache format version stayed at 1, so 0.1.x entries were reused
  and reported old scores as current findings.
- A ternary inside a template interpolation (`` `${cond ? a : b}` ``) is no
  longer branch-swapped: the swap moved code outside the `${…}` and produced a
  guaranteed syntax error.

### Added

- `.vue` and `.svelte` files are no longer "unsupported": their `<script>` block
  is read by `check`, so tests inside single-file components are analysed. They
  are still not mutated, and the report says which files were read.
- Weekly CI job (`real-projects.yml`) runs `check` against axios, express,
  lodash, p-map, chalk and slugify and fails when any "certain" finding appears
  on a healthy project — the false-positive guarantee, guarded continuously
  instead of manually.

## 0.2.0 — 2026-11-27

Correctness, safety and speed.

### Fixed

- `scan` now exits 1 when a test certainly cannot fail, as the README has always
  claimed. A CI step that gated on `scan` was silently passing.
- Generated tests for jest projects no longer import `vitest`. Jest gets its
  globals from the framework; importing another test runner made `fix` write a
  file that could not run.
- Boundary fixing now works on TypeScript. The probe used to run under plain
  `node`, which cannot resolve an extensionless `.ts` import, so every TS boundary
  fix silently fell back to value pinning. The probe now goes through the
  project's own runner.
- `--limit`, `--jobs` and `--fail-under` reject non-numeric or out-of-range
  values instead of silently auditing nothing. Unknown options are an error.
- `--json` emits the same deduplicated findings the summary is computed from, so
  the counts agree. `--no-mutation` no longer tells an agent the suite is red when
  no tests were run.
- `fix` rolls back its generated files when the suite goes red afterwards.
- Value-pinning probes run under plain `node` for JavaScript instead of running
  the whole suite.
- Two object-boundary fixes in one module no longer overwrite each other: each
  function gets its own generated file (`<base>.<fn>.exact.test.js`).
- Generated Python tests render `True`/`False`/`None` and container literals in
  Python, not JSON, and slug a dotted threshold into a valid `def` name.
- A one-line `except ...: pass` is reported once, not twice.
- `node --test` narrowing keeps loader flags (`--import tsx`) and the project's
  other test flags instead of dropping them.
- JavaScript probes use `.mjs`, so they work in CommonJS packages too.
- `fix` says "dependencies are not installed" when that is the real problem,
  instead of calling the suite red.

### Added

- Incremental cache keyed by source bytes, covering-test bytes, command, profile
  and mutation cap. A second audit of unchanged files is near-instant. Disable
  with `--no-cache`.
- Parallel audits in temporary sandbox copies (`--jobs=N`, default `min(4, cpus)`).
  Each sandbox must run the suite green before its results are trusted; otherwise
  crucible falls back to the in-place sequential path.
- Single-file targets: `crucible check src/cart.js`, `crucible scan src/cart.js`.
- `--fail-under=N` gates CI on the pooled mutation score.
- Python test functions are analysed by `check`: `def test_*` bodies with no
  assertion, `pytest.raises`, skip decorators and `except: pass` are recognised.
- Test files in unsupported formats (`.vue`, `.svelte`, …) are counted and
  reported as skipped instead of vanishing from the report.
- Monorepo roots with no local runner print the workspace packages to run
  against.
- New mutation operators: ternary branch swap and forcing an `if` condition true.
  `mock-self` now recognises `jest.mock`.
- GitHub Actions matrix (Linux, macOS, Windows × Node 20/22/24). Windows is
  reported but not gated yet.
- `--jobs`, `--no-cache` and `--fail-under` documented; score now pooled across
  files instead of averaging per-file percentages.

### Safety

- SIGINT/SIGTERM/SIGHUP restore any file currently mutated and remove temporary
  sandboxes before exiting. Ctrl-C mid-audit used to leave the source rewritten
  in place.

## 0.1.4

- `crucible install` copies the agent skill from the published package.
- The "cannot work it out" path tells the user where to report it.

## 0.1.3

- Portable path handling and `--version`.
- `crucible check` fast path, plus nine detection fixes found by running against
  real projects.
- Environment failures are reported as environment failures, not failing tests.

## 0.1.2

- Python boundary fixing; refuse instead of guessing a runner.
- Generated tests are never overwritten after a hand edit.

## 0.1.1

- Agent-facing skill and machine-readable `next` steps.

## 0.1.0

- First published version: static detectors, mutation scanning, boundary fixing.
