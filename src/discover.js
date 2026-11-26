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

async function walk(dir, root, acc, depth = 0) {
  if (depth > 12) return;

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
    const ext = extname(entry.name);
    if (!SOURCE_EXT.has(ext)) continue;

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

    if (deps.vitest) return { command: 'npx --no-install vitest run --reporter=basic', name: 'vitest' };
    if (deps.jest) return { command: 'npx --no-install jest --ci', name: 'jest' };

    // Prefer the project's own test script: it knows where the tests live and
    // which flags they need. Guessing a glob is how you end up running zero tests
    // and reporting every mutation as a survivor.
    const script = pkg.scripts?.test;
    if (script) {
      const parts = script.split('&&').map((s) => s.trim());

      const cleaned = parts
        // Drop pure lint/typecheck steps.
        .filter((s) => !/^(xo|eslint|biome|prettier|tsc|tsd|del-cli)\b/.test(s))
        // Strip coverage wrappers but keep the command they wrap.
        .map((s) => s.replace(/^(c8|nyc)\s+/, ''))
        .filter((s) => /node --test|vitest|jest|mocha|ava|tape/.test(s))
        .join(' && ')
        .trim();

      if (cleaned) {
        // A local binary (ava, mocha, tap) is only on PATH inside `npm run`. Use
        // `npx --no-install` so it resolves from node_modules/.bin without a
        // download. `node` and `npx` are already global; leave them alone.
        const needsNpx = /^(ava|mocha|tap|uvu|jasmine|karma|vitest|jest)\b/.test(cleaned);
        return {
          command: needsNpx ? `npx --no-install ${cleaned}` : cleaned,
          name: 'package script',
        };
      }
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
export async function discover(root) {
  const abs = resolve(root);
  const acc = { sourceFiles: [], testFiles: [] };
  await walk(abs, abs, acc);

  /** @type {Map<string,string[]>} */
  const covers = new Map();
  for (const src of acc.sourceFiles) covers.set(src, []);

  // Build a lookup from normalised source key to absolute source path.
  const byKey = new Map();
  for (const src of acc.sourceFiles) byKey.set(normalisePath(abs, src), src);

  for (const testFile of acc.testFiles) {
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
  };
}
