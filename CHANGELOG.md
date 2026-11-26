# Changelog

All notable changes to crucible. Versions follow semver; anything before 1.0 may
still change behaviour in a minor release.

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
