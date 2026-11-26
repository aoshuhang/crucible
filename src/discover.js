/**
 * Project discovery: find source files, test files, and which tests cover which
 * source.
 *
 * This distinction is the difference between an honest report and a useless one:
 *   - a source file with no test importing it is UNTESTED
 *   - a source file whose tests pass after we break it has a FAKE test
 * Only the second one is the product. Reporting "untested" as "fake test" would
 * destroy credibility on the first real project anyone runs it against.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, dirname, basename, extname } from 'node:path';

/** Directories that never contain product source worth auditing. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'vendor',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', 'target', '__pycache__',
  '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', 'Pods', 'DerivedData',
  '.build', 'tmp', 'temp', '.idea', '.vscode', 'fixtures', '__fixtures__',
]);

/** Test-file naming conventions across ecosystems. */
const TEST_PATTERNS = [
  /\.(test|spec)\.[cm]?[jt]sx?$/,        // foo.test.ts, foo.spec.jsx
  /(^|\/)test_[^/]+\.py$/,               // test_foo.py
  /(^|\/)[^/]+_test\.py$/,               // foo_test.py
  /(^|\/)tests?\/.*\.[cm]?[jt]sx?$/,     // tests/anything.js
  /(^|\/)__tests__\/.*\.[cm]?[jt]sx?$/,  // __tests__/anything.js
  /(^|\/)test\.[cm]?[jt]sx?$/,           // test.js at the project root
  /(^|\/)tests\.[cm]?[jt]sx?$/,          // tests.js
  /_test\.go$/,                          // foo_test.go  (Go)
  /_test\.rs$/,                          // tests live in #[cfg(test)] or tests/
  /Tests?\.swift$/,                      // FooTests.swift
  /(^|\/)[^/]+Tests?\.(cs|java|kt)$/,    // FooTest.cs
];

/** Source extensions we can mutate. */
const SOURCE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
  '.py', '.go', '.rs', '.swift', '.java', '.kt', '.cs',
]);

/**
 * Source formats people reasonably expect to be audited but that crucible does not
 * parse. Counting them matters: silently skipping every `.vue` file in a Vue project
 * looks exactly like a clean report.
 */
const UNSUPPORTED_SOURCE_EXT = new Set([
  '.vue', '.svelte', '.astro', '.rb', '.php', '.scala', '.ex', '.exs', '.erl',
  '.hs', '.clj', '.cljs', '.dart', '.lua', '.fs', '.jl', '.m', '.mm',
]);

/** Files that are entry points or config, not worth mutating. */
const SKIP_SOURCE = /(^|\/)(main|setup|config|vite\.config|jest\.config|vitest\.config|webpack\.config|rollup\.config|tsup\.config|eslint\.config)\.[cm]?[jt]sx?$/;

/** Type declaration files carry no runtime behaviour to mutate. */
const SKIP_SOURCE_EXT = /\.d\.[cm]?ts$/;

/** Directories that are entry points rather than library code. */
const SKIP_SOURCE_DIR = /(^|\/)(bin|scripts|cli|fixtures|__fixtures__)\//;

/**
 * @typedef {object} Project
 * @property {string} root
 * @property {string[]} sourceFiles    absolute paths
 * @property {string[]} testFiles      absolute paths
 * @property {Map<string,string[]>} covers  source path -> test paths that reference it
 * @property {{ command: string, name: string } | null} runner
 */

/**
 * Depth limit for the directory walk.
 *
 * 12 was too shallow: a Java or Kotlin project reaches
 * `src/main/java/com/company/product/module/feature/...` easily, and a monorepo
 * adds more on top. The walk silently found zero files and the report looked like
 * a clean project with no source.
 *
 * 64 covers realistic nesting including deep Java package paths. Deeper than that
 * output, and we say so instead of guessing.
 */
const MAX_DEPTH = 64;

async function walk(dir, root, acc, depth = 0) {
  if (depth > MAX_DEPTH) {
    acc.truncated = true;
    return;
  }

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      await walk(full, root, acc, depth + 1);
      continue;
    }

    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (!SOURCE_EXT.has(ext)) {
      if (UNSUPPORTED_SOURCE_EXT.has(ext)) {
        if (!acc.unsupported) acc.unsupported = new Map();
        acc.unsupported.set(ext, (acc.unsupported.get(ext) ?? 0) + 1);
      }
      continue;
    }

    const isTest = TEST_PATTERNS.some((re) => re.test(relative(root, full).split('\\').join('/')));
    if (isTest) acc.testFiles.push(full);
    else if (!SKIP_SOURCE.test(relative(root, full)) && !SKIP_SOURCE_EXT.test(entry.name)) {
      const rel = relative(root, full).split('\\').join('/');
      if (SKIP_SOURCE_DIR.test(rel)) continue;
      acc.sourceFiles.push(full);
    }
  }
}

/**
 * Read a test file and extract every import/require path plus bare identifiers.
 * We resolve them relative to the test file and match against known sources.
 */
function referencedSpecifiers(text) {
  const specs = new Set();

  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,            // ES import ... from 'x'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import('x')
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require('x')
    /^\s*import\s+['"]([^'"]+)['"]/gm,        // side-effect import 'x'
    /\b(?:from|import)\s+([\w.]+)\s+import/g, // python: from x import
  ];

  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) specs.add(m[1]);
  }

  return [...specs];
}

/**
 * Normalise a module specifier to a comparable form: strip extension, strip
 * trailing /index, drop a leading './'.
 */
function normaliseSpec(spec) {
  let s = spec.replace(/\\/g, '/');
  s = s.replace(/^\.\//, '');
  s = s.replace(/\.[cm]?[jt]sx?$/, '');
  s = s.replace(/\.py$/, '');
  s = s.replace(/\/index$/, '');
  return s;
}

/** The comparable key for a real file path. */
function normalisePath(root, file) {
  let rel = relative(root, file).replace(/\\/g, '/');
  rel = rel.replace(/\.[cm]?[jt]sx?$/, '');
  rel = rel.replace(/\.py$/, '');
  rel = rel.replace(/\/index$/, '');
  return rel;
}

/**
 * Decide how to run this project's tests.
 *
 * `npm run test` is avoided on purpose: when crucible runs inside a test process,
 * node:test refuses to nest and silently skips the suite, which would make every
 * mutation look like it survived.
 *
 * The command must also work when invoked directly. A bare binary name like `ava`
 * only resolves inside `npm run`, because npm puts `node_modules/.bin` on PATH.
 * Run outside it and you get exit 127, which looks exactly like a failing suite —
 * so every ava, mocha and tap project would be rejected with "suite is red".
 * Prefixing with `npx --no-install` fixes that without allowing a download.
 */
/**
 * Prefer the project's own binary over anything npx can find.
 *
 * `npx --no-install vitest` falls back to the npx cache when the project has no
 * node_modules, so crucible could run an unrelated vitest version against the
 * user's code and report a crash as a failing suite. The local bin is the only
 * correct answer; when it is absent the project needs an install, and saying so
 * is better than running the wrong tool.
 */
async function localBin(root, name) {
  try {
    await stat(join(root, 'node_modules', '.bin', name));
    return `./node_modules/.bin/${name}`;
  } catch {
    return null;
  }
}

/**
 * Detect which package manager the project uses, so the install hint is right.
 */
async function detectPackageManager(root) {
  const has = async (name) => {
    try {
      await stat(join(root, name));
      return true;
    } catch {
      return false;
    }
  };

  if (await has('pnpm-lock.yaml')) return 'pnpm';
  if (await has('yarn.lock')) return 'yarn';
  if (await has('bun.lockb')) return 'bun';
  if (await has('package-lock.json')) return 'npm';
  return 'npm';
}

/**
 * Resolve a package script to a runnable command, following `npm run <other>`.
 *
 * Real projects nest scripts: lodash's `test` is
 * `npm run test:main && npm run test:fp`. Refusing all of those would reject a
 * 40k-star project for no reason. The recursion is depth-limited because scripts
 * can call each other in a cycle.
 */
async function resolveScript(root, scriptName, pkg, depth) {
  if (depth > 3) return null;

  const body = pkg.scripts?.[scriptName];
  if (!body) return null;

  const parts = body.split('&&').map((s) => s.trim()).filter(Boolean);
  const kept = [];
  let installed = true;

  for (const part of parts) {
    // Drop pure lint/typecheck steps.
    if (/^(xo|eslint|biome|prettier|tsc|tsd|del-cli|jscs)\b/.test(part)) continue;

    // Strip coverage wrappers but keep the command they wrap.
    const unwrapped = part.replace(/^(c8|nyc|istanbul cover)\s+/, '');

    // Follow a nested `npm run <name>`.
    const nested = unwrapped.match(/^(?:npm|pnpm|yarn)\s+run\s+([\w:.-]+)$/);
    if (nested) {
      const inner = await resolveScript(root, nested[1], pkg, depth + 1);
      if (inner) {
        kept.push(inner.command);
        if (!inner.installed) installed = false;
      }
      continue;
    }

    // Strip a leading `npx --no-install` / `bunx` / `pnpm exec`: the project's own
    // script may use one, and we address the binary locally instead.
    const stripped = unwrapped.replace(/^(?:npx\s+(?:--no-install\s+|-y\s+)?|bunx\s+|pnpm\s+exec\s+)/, '');

    const bare = stripped.match(/^(ava|mocha|tap|uvu|jasmine|karma|vitest|jest)\b/);
    if (bare) {
      // A local binary is only on PATH inside `npm run`. Point at
      // node_modules/.bin so a missing install fails loudly instead of silently
      // reaching into the npx cache.
      const bin = await localBin(root, bare[1]);
      kept.push(bin ? stripped.replace(bare[1], bin) : `./node_modules/.bin/${stripped}`);
      if (!bin) installed = false;
      continue;
    }

    if (/node --test|node\s+-e/.test(unwrapped)) {
      kept.push(unwrapped);
      continue;
    }

    // `node test/test` — a project's own runner entry point. lodash uses this.
    // It is a real test command, not a build step. Excluded are bare `node` calls
    // with flags (--version, -p) and anything that is obviously a script command.
    if (/^node\s+[^-\s]/.test(unwrapped) && /test|spec/i.test(unwrapped)) {
      kept.push(unwrapped);
      continue;
    }
  }

  if (kept.length === 0) return null;
  return { command: kept.join(' && '), name: 'package script', installed };
}

async function detectRunner(root) {
  const has = async (name) => {
    try {
      await stat(join(root, name));
      return true;
    } catch {
      return false;
    }
  };

  let pkg = null;
  if (await has('package.json')) {
    try {
      pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    } catch {
      pkg = null;
    }
  }

  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    // Prefer the project's own binary. Never let npx reach its cache.
    const vitestBin = await localBin(root, 'vitest');
    const jestBin = await localBin(root, 'jest');

    if (deps.vitest || vitestBin) {
      // If the dependency is declared but not installed, point at the local path
      // anyway. It will fail with "no such file", which is honest: the project is
      // not installed. Falling back to npx would run a cached version of vitest
      // against this project's code, and a crash from a version mismatch would be
      // reported as a failing suite.
      return {
        command: `${vitestBin ?? './node_modules/.bin/vitest'} run`,
        name: 'vitest',
        installed: Boolean(vitestBin),
      };
    }
    if (deps.jest || jestBin) {
      return {
        command: `${jestBin ?? './node_modules/.bin/jest'} --ci`,
        name: 'jest',
        installed: Boolean(jestBin),
      };
    }

    // Prefer the project's own test script: it knows where the tests live and
    // which flags they need. Guessing a glob is how you end up running zero tests
    // and reporting every mutation as a survivor.
    const script = pkg.scripts?.test;
    if (script) {
      const resolved = await resolveScript(root, 'test', pkg, 0);
      if (resolved) return resolved;
    }
  }

  for (const [file, command, name] of [
    ['pytest.ini', 'python3 -m pytest -x -q', 'pytest'],
    ['pyproject.toml', 'python3 -m pytest -x -q', 'pytest'],
    ['tox.ini', 'python3 -m pytest -x -q', 'pytest'],
    ['go.mod', 'go test ./...', 'go test'],
    ['Cargo.toml', 'cargo test --quiet', 'cargo test'],
    ['Package.swift', 'swift test', 'swift test'],
  ]) {
    if (await has(file)) return { command, name };
  }

  // Xcode projects: find the scheme and the test target so the command is concrete.
  // `xcodebuild test` is slow (it rebuilds), so callers must keep --limit small.
  try {
    const entries = await readdir(root);
    const proj = entries.find((e) => e.endsWith('.xcodeproj'));
    const ws = entries.find((e) => e.endsWith('.xcworkspace'));

    if (proj || ws) {
      const container = ws ? `-workspace ${JSON.stringify(ws)}` : `-project ${JSON.stringify(proj)}`;
      // The scheme usually matches the project name without the extension.
      const scheme = (proj ?? ws).replace(/\.(xcodeproj|xcworkspace)$/, '');
      return {
        command: `xcodebuild test ${container} -scheme ${JSON.stringify(scheme)} -destination 'platform=macOS' -quiet`,
        name: 'xcodebuild',
        slow: true,
      };
    }
  } catch { /* ignore */ }

  // Last resort: read the test script and rewrite `npm run test` into a direct
  // invocation so it survives being called from inside a test process.
  if (pkg?.scripts?.test) {
    const script = pkg.scripts.test;
    if (script.includes('node --test')) {
      const direct = script.replace(/^npm run \w+\s*(--\s*)?/, '').trim();
      if (direct.startsWith('node --test')) {
        return { command: direct, name: 'node:test' };
      }
    }
  }

  // No fallback glob. Guessing `tests/*.test.js` on a project whose tests live
  // elsewhere runs zero tests, the suite is always green, and every mutation is
  // reported as a survivor — a confident 0% about a healthy project. Reporting
  // "no runner" is the honest answer, and the caller turns it into a clear error.
  return null;
}

/**
 * @param {string} root
 * @returns {Promise<Project>}
 */
/**
 * The nearest directory that looks like a project root.
 *
 * A single-file target has to know where the runner lives; its own directory is
 * often a deep `src/` folder with no package.json anywhere near it.
 */
async function findProjectRoot(start) {
  let dir = start;
  for (;;) {
    for (const marker of ['package.json', 'pyproject.toml', 'pytest.ini', 'tox.ini',
      'go.mod', 'Cargo.toml', 'Package.swift']) {
      try {
        await stat(join(dir, marker));
        return dir;
      } catch { /* keep walking up */ }
    }
    try {
      await stat(join(dir, '.git'));
      return dir;
    } catch { /* keep walking up */ }

    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/**
 * Audit one file, discovered from the project it belongs to.
 *
 * `crucible scan src/foo.ts` is the natural thing to type while working on one
 * file. Walking a file path used to find nothing and then blame the runner.
 */
async function discoverFile(file) {
  const projectRoot = await findProjectRoot(dirname(file));
  const full = await discover(projectRoot);
  const rel = relative(projectRoot, file).split('\\').join('/');
  const isTest = TEST_PATTERNS.some((re) => re.test(rel));

  if (isTest) {
    // A test-file target only needs the static pass; there is no source to mutate.
    return { ...full, testFiles: [file], sourceFiles: [], covers: new Map(), targetedFile: rel };
  }

  const tests = full.covers.get(file) ?? [];
  return {
    ...full,
    sourceFiles: [file],
    testFiles: tests,
    covers: new Map([[file, tests]]),
    targetedFile: rel,
  };
}

/** Workspace globs declared by the project (npm/yarn `workspaces`, pnpm yaml). */
async function workspacePatterns(root) {
  const patterns = [];

  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (Array.isArray(pkg.workspaces)) patterns.push(...pkg.workspaces);
    else if (Array.isArray(pkg.workspaces?.packages)) patterns.push(...pkg.workspaces.packages);
  } catch { /* no package.json */ }

  try {
    const yaml = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8');
    for (const line of yaml.split('\n')) {
      const m = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/);
      if (m) patterns.push(m[1]);
    }
  } catch { /* no pnpm workspace */ }

  return patterns;
}

/**
 * Package directories a workspace declares.
 *
 * Only simple globs are expanded (`packages/*`, `apps/*`). A monorepo root almost
 * never has the runner installed, so detecting this turns "no test runner" into an
 * actionable list of directories.
 */
async function expandWorkspacePattern(root, pattern) {
  const dirs = new Set();

  if (pattern.endsWith('/*')) {
    const parent = join(root, pattern.slice(0, -2));
    let entries;
    try {
      entries = await readdir(parent, { withFileTypes: true });
    } catch {
      return dirs;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) dirs.add(join(parent, entry.name));
    }
    return dirs;
  }

  if (!/[*?]/.test(pattern)) dirs.add(join(root, pattern));
  return dirs;
}

export async function workspaceDirs(root) {
  const patterns = await workspacePatterns(root);
  const found = new Set();
  const excluded = new Set();

  for (const raw of patterns) {
    const pattern = String(raw).trim();
    if (!pattern) continue;

    const negated = pattern.startsWith('!');
    const body = negated ? pattern.slice(1) : pattern;
    const dirs = await expandWorkspacePattern(root, body);
    for (const dir of dirs) {
      if (negated) excluded.add(dir);
      else found.add(dir);
    }
  }

  const packages = [];
  for (const dir of found) {
    if (excluded.has(dir)) continue;
    for (const marker of ['package.json', 'pyproject.toml', 'Cargo.toml']) {
      try {
        await stat(join(dir, marker));
        packages.push(dir);
        break;
      } catch { /* not a package */ }
    }
  }

  return packages.sort();
}

export async function discover(root) {
  const abs = resolve(root);

  // A file target: audit just that file, in the project that owns it.
  try {
    const info = await stat(abs);
    if (info.isFile()) return discoverFile(abs);
  } catch { /* fall through to directory handling */ }

  const acc = { sourceFiles: [], testFiles: [], truncated: false };
  await walk(abs, abs, acc);

  /** @type {Map<string,string[]>} */
  const covers = new Map();
  for (const src of acc.sourceFiles) covers.set(src, []);

  // Build a lookup from normalised source key to absolute source path.
  const byKey = new Map();
  for (const src of acc.sourceFiles) byKey.set(normalisePath(abs, src), src);

  // Sorted, not readdir order: the covering-test list feeds the cache key and the
  // report, so it must be the same on every run and every machine.
  for (const testFile of [...acc.testFiles].sort()) {
    let text;
    try {
      text = await readFile(testFile, 'utf8');
    } catch {
      continue;
    }

    const specs = referencedSpecifiers(text);
    const seen = new Set();

    for (const spec of specs) {
      if (spec.startsWith('node:') || spec.startsWith('http')) continue;

      // Relative specifier: resolve against the test file's directory.
      let key = null;
      if (spec.startsWith('.')) {
        const resolved = resolve(dirname(testFile), spec);
        key = normalisePath(abs, resolved);
      } else if (!spec.startsWith('@') && spec.includes('/')) {
        // Python-style dotted module or a bare path; try as a project-relative path.
        key = normaliseSpec(spec);
      } else {
        key = normaliseSpec(spec);
      }

      const target = byKey.get(key);
      if (target && !seen.has(target)) {
        seen.add(target);
        covers.get(target).push(testFile);
      }
    }

    // Fallback: a test that mentions the source basename is likely covering it.
    for (const src of acc.sourceFiles) {
      if (seen.has(src)) continue;
      const base = basename(src).replace(/\.[^.]+$/, '');
      if (base.length < 4) continue;
      const re = new RegExp(`\\b${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      if (re.test(text)) {
        seen.add(src);
        covers.get(src).push(testFile);
      }
    }

    // Go convention: `foo_test.go` sits beside `foo.go` in the same package and
    // calls its functions directly, so there is no import to resolve. Match by
    // name and directory instead.
    const goTest = testFile.match(/^(.*)\/([^/]+)_test\.go$/);
    if (goTest) {
      const [, dir, base] = goTest;
      const sibling = byKey.get(normalisePath(abs, `${dir}/${base}.go`));
      if (sibling && !seen.has(sibling)) {
        seen.add(sibling);
        covers.get(sibling).push(testFile);
      }
    }
  }

  return {
    root: abs,
    sourceFiles: acc.sourceFiles.sort(),
    testFiles: acc.testFiles.sort(),
    covers,
    runner: await detectRunner(abs),
    packageManager: await detectPackageManager(abs),
    truncated: acc.truncated,
    unsupported: acc.unsupported
      ? [...acc.unsupported.entries()]
        .map(([ext, count]) => ({ ext, count }))
        .sort((a, b) => b.count - a.count)
      : [],
    workspaces: await workspaceDirs(abs),
  };
}
