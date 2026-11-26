---
name: Wrong result
about: A test you know is fine gets flagged, or a real one is missed
title: ''
labels: ''
assignees: ''
---

A wrong report is the most useful bug you can file here. A tool that cries wolf is
worse than no tool.

**Which command, and what did it say?**
<!-- paste the output of `crucible check --json` or `crucible scan --json` -->

```

```

**What did you expect instead?**
<!-- e.g. "this test does assert something, see the helper it calls on line 40" -->

**The test (or the smallest version of it that still reproduces)**
```js
// paste the test block
```

**Environment**
- crucible version: <!-- crucible --version -->
- Node version: <!-- node --version -->
- Platform: <!-- macOS 15 / Ubuntu 24.04 / Windows 11 -->
- Test runner: <!-- vitest / jest / node:test / ava / pytest / go / cargo / swift -->
- Project size: <!-- roughly how many source and test files -->

**If it refused to run, what did it say?**
<!-- "no test runner detected" / "dependencies are not installed" / "environment error" / "suite is red" -->

**Anything else that would help**
<!-- a link to the repo, if it is public -->
