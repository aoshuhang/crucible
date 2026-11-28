---
name: crucible
description: Verify that tests actually catch bugs. Use when tests were just written or generated, when the user asks whether their tests are real or meaningful, when coverage looks high but bugs keep shipping, when the user asks to "check the tests", "audit the test suite" or "make tests stronger", or before declaring a task done that involved writing tests. Runs mutation testing: breaks source on purpose and reports which breaks the suite never noticed.
---

# Crucible

A test suite is a crucible: it either shows the flaws in the metal or it does not.
Most AI-written tests pass forever because they assert nothing — the type, the
shape, the truthiness. `crucible` finds them by breaking the source on purpose and
checking whether the suite notices, then writes the test that would have caught it.

## When to run it

Run it whenever tests were part of the work and you are about to say the work is
done. Specifically:

- You just wrote or modified tests.
- The user asks whether the tests are meaningful, real, or worth having.
- A project has high coverage but the user keeps finding bugs.
- The user says "check my tests", "audit the tests", "are these tests fake".

Do not run it on a project whose suite is already failing — the command refuses,
which is correct.

## How to run it

```bash
npx @hsaohuang/crucible check <path>        # fast: which tests cannot fail
npx @hsaohuang/crucible scan <path> --json  # slow: untested boundaries
npx @hsaohuang/crucible fix <path>          # write the missing tests
```

`<path>` is a directory or a single file; point it at the file you just touched
when that is the whole change (`crucible scan src/cart.js`).

`scan` runs the project's tests once per mutation. On a real project that is
**seconds to minutes**, not instant. Tell the user you are running it before you
start, and use `--limit=N` (default 12) to keep it bounded. Results are cached by
file content and dependency environment, so a second run over unchanged files is
fast; `--jobs=N` runs mutations in parallel sandbox copies.

A default score is a **sample**. Before quoting it as project quality, read
`scoreKind` and `sampling`. For a complete gate use:

```bash
npx @hsaohuang/crucible scan <path> --limit=all --mutations=all --select=all --json
```

`scan` exits 1 when something certainly cannot fail and 2 when it could not run at
all (no runner, red suite). `--fail-under=N` adds a mutation-score gate for CI;
when the score is sampled, the gate text states how much was audited.

Read the JSON, not the human output, when you need to act on it:

```json
{
  "summary": { "fakeTests": 2, "likelyFake": 4, "worthChecking": 3 },
  "mutationScore": 58,
  "scoreKind": "sampled",
  "sampling": {
    "mode": "files",
    "filesAudited": 12,
    "filesCovered": 15,
    "filesNotAudited": 3,
    "filesWithoutMutants": 1,
    "filesIncomplete": 0,
    "mutantsExecuted": 144,
    "mutantsAvailable": 611,
    "complete": false
  },
  "limit": 12,
  "notAudited": 3,
  "heuristicCovers": [
    { "source": "src/legacy.js", "tests": ["test/smoke.test.js"] }
  ],
  "findings": [
    {
      "id": "no-assertion",
      "file": "test/cart.test.js",
      "line": 10,
      "column": null,
      "kind": "empty",
      "snippet": "it('clamp runs')",
      "why": "test runs code but never asserts anything",
      "fix": "assert on the result, or delete the test",
      "confidence": "certain"
    }
  ],
  "files": [
    {
      "file": "src/cart.js",
      "score": 0.5,
      "killed": 6,
      "survived": 6,
      "survivors": [{ "line": 14, "column": 22, "kind": "arithmetic", "description": "flip * to /" }]
    }
  ]
}
```

`notAudited` is the number of covered files `--limit` left out; if it is non-zero,
the report is partial. `sampling.complete` is the authoritative flag. A
`heuristicCovers` entry is only a basename clue and is deliberately excluded from
scores. `files[].survivors` names every surviving mutation, so you can write the
missing test without re-running anything. `files[].parseError` means the file
could not be parsed and was not audited.

`fix --json` reports each written file under `written` and a replay result under
`repairs`. Only `status: "repaired"` means the generated test killed every target
mutation. `unverified` and `partial` are not evidence of a repair, even when the
suite is green.

## How to read the confidence grades

This is the part that decides what you are allowed to claim.

| grade | meaning | what to do |
|---|---|---|
| `certain` | provable by reading one line | fix it, no debate |
| `likely` | a deliberate break went unnoticed | fix it, it is almost certainly a gap |
| `suspect` | tests pin values, are explicit smoke/skip tests, or may be intentional | mention it, do not call it a fake test |

Never tell the user their tests are fake based on a `suspect` finding. A property
test on a noise function legitimately survives a constant tweak, and an integration
test skipped because Kafka is unavailable is a deliberate gate.

## What `fix` cannot do

It refuses to write a test when the comparison feeds an intermediate variable that
several branches consume — probing the boundary would return the same value three
times, and the resulting test would pin three identical values and catch nothing.
That is the exact defect the tool exists to find, so it declines and prints the
comparison for a human instead.

When the output says `manual`, write that test yourself. It tells you the
expression and the case you need. When `fix --json` writes nothing, read
`skipped[]`: CommonJS exports, unobservable intermediate comparisons and probes
that cannot read values are stated limitations, not proof that the suite is fine.

## Do not do this

- Do not run `fix` and then claim the tests are now real without checking
  `repairs[].status` and re-running `scan` to see the score move.
- Do not quote a `sampled` score as the whole project's quality, and do not claim
  a `--fail-under` pass proves the project when files or mutants were left out.
- Do not treat a low score as a verdict on the developer. A 52% score on a game
  prototype with a state machine is normal; the useful part is the list of specific
  untested edges.
- Do not run it on Xcode projects. One `xcodebuild test` cycle was measured at
  5m37s, so an audit takes over an hour. Say so instead.
- Do not ignore `notAudited` in the JSON: when it is non-zero, the report covered
  only the first `limit` covered files, and "nothing found" means "nothing found
  in those files".
