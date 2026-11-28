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
import { parseJs, walk as walkAst, isJsFile } from './js-ast.js';
import { pythonCommand } from './python-runtime.js';

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
  /(^|\/)tests\/.*\.rs$/,                // Rust integration-test convention
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
 *
 * `.vue` and `.svelte` are handled separately below: their `<script>` block IS
 * JavaScript, so `check` can read it even though mutation cannot write it back
 * safely. Everything else here stays counted-and-skipped.
 */
const UNSUPPORTED_SOURCE_EXT = new Set([
  '.astro', '.rb', '.php', '.scala', '.ex', '.exs', '.erl',
  '.hs', '.clj', '.cljs', '.dart', '.lua', '.fs', '.jl', '.m', '.mm',
]);

/** Single-file components whose `<script>` block is JavaScript. */
const SFC_EXT = new Set(['.vue', '.svelte']);

/** Files that are entry points or config, not worth mutating. */
const SKIP_SOURCE = /(^|\/)(main|setup|config|vite\.config|jest\.config|vitest\.config|webpack\.config|rollup\.config|tsup\.config|eslint\.config|playwright\.config|babel\.config|gulpfile|Gruntfile)\.[cm]?[jt]sx?$/;

/**
 * Test support, examples and build tooling are not product source. Test FILES in
 * these directories are still discovered; only non-test source candidates are
 * excluded. Before this, Flask's tests/conftest.py and tests/test_apps fixtures,
 * axios examples and lodash build scripts appeared as "untested source".
 */
const SKIP_SOURCE_PATH = /(^|\/)(?:tests?|__tests__|__mocks__|examples?|samples?|docs?|docs?[-_]src|benchmarks?|perf|sandbox|integrations?(?:-tests?)?|_support)\//;

/** Type declaration files carry no runtime behaviour to mutate. */
const SKIP_SOURCE_EXT = /\.d\.[cm]?ts$/;

/** Hidden JS files are tool setup (.markdown-doctest-setup.js), not product code. */
const HIDDEN_JS = /^\./;

/** Directories that are entry points rather than library code. */
const SKIP_SOURCE_DIR = /(^|\/)(bin|scripts|cli|fixtures|__fixtures__)\//;

/**
 * Extract the `<script>` block from a single-file component.
 *
 * `check` analyses the script inside a `.vue`/`.svelte` file; without this the
 * whole file was skipped as "unsupported" and the tests inside it were invisible.
 * Returns null when there is no script block at all.
 */
export function sfcScript(source) {
  const match = source.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
  return match ? match[1] : null;
}

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

    // A single-file component is not counted as "unsupported" when it actually
    // carries a script block: the static pass can read that script even though
    // `scan`/`fix` still cannot mutate the file. Vue projects were previously
    // reported as "skipped: everything", which reads as "untested" at best and
    // "fine" at worst — both wrong.
    if (SFC_EXT.has(ext)) {
      acc.sfcFiles.push(full);
      continue;
    }

    if (!SOURCE_EXT.has(ext)) {
      if (UNSUPPORTED_SOURCE_EXT.has(ext)) {
        if (!acc.unsupported) acc.unsupported = new Map();
        acc.unsupported.set(ext, (acc.unsupported.get(ext) ?? 0) + 1);
      }
      continue;
    }

    const isTest = TEST_PATTERNS.some((re) => re.test(relative(root, full).split('\\').join('/')));
    if (isTest) acc.testFiles.push(full);
    else if (!SKIP_SOURCE.test(relative(root, full)) && !SKIP_SOURCE_EXT.test(entry.name)
      && !(HIDDEN_JS.test(entry.name) && /\.[cm]?jsx?$/.test(entry.name))) {
      const rel = relative(root, full).split('\\').join('/');
      if (SKIP_SOURCE_DIR.test(rel) || SKIP_SOURCE_PATH.test(rel)) continue;
      acc.sourceFiles.push(full);
    }
  }
}

/**
 * Read a test file and extract every import/require path plus bare identifiers.
 * We resolve them relative to the test file and match against known sources.
 */
function referencedSpecifiers(text, file = '', parsed = undefined) {
  const specs = new Set();

  if (isJsFile(file)) {
    // AST imports only. Regex scanning also saw sample code in strings/comments,
    // which could make an unrelated test look like a covering test.
    const ast = parsed === undefined ? parseJs(text, file).ast : parsed;
    if (!ast) return [];
    walkAst(ast.program, (node) => {
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)
        && node.source?.type === 'StringLiteral') specs.add(node.source.value);
      if (node.type === 'CallExpression' && node.arguments[0]?.type === 'StringLiteral'
        && (node.callee.type === 'Import'
          || (node.callee.type === 'Identifier' && node.callee.name === 'require'))) {
        specs.add(node.arguments[0].value);
      }
    });
    return [...specs];
  }

  const patterns = [
    /\b(?:from|import)\s+([\w.]+)\s+import/g, // python: from x import
    /^\s*import\s+([\w.]+)\s*$/gm,           // python: import x
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
 *
 * A dotted Python module (`from lib.mod import clamp`) refers to `lib/mod.py`,
 * so dots become slashes. Dotless specifiers are left untouched — a package
 * name like `slugify` must not be mangled.
 */
function normaliseSpec(spec) {
  let s = spec.replace(/\\/g, '/');
  s = s.replace(/^\.\//, '');
  s = s.replace(/\.[cm]?[jt]sx?$/, '');
  s = s.replace(/\.py$/, '');
  s = s.replace(/\/index$/, '');
  if (!s.includes('/') && s.includes('.')) s = s.replace(/\./g, '/');
  return s;
}

/**
 * The JS counterpart: same normalisation, but dots are NEVER separators.
 * `lodash.merge` is an npm package name; converting it to `lodash/merge` would
 * falsely map a test onto a local file that happens to share the path.
 * Exported for tests: the no-dot-conversion rule is the regression guard.
 */
export function normaliseJsSpec(spec) {
  let s = spec.replace(/\\/g, '/');
  s = s.replace(/^\.\//, '');
  s = s.replace(/\.[cm]?[jt]sx?$/, '');
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

  const python = pythonCommand();
  for (const [file, command, name] of [
    ['pytest.ini', `${python} -m pytest -x -q`, 'pytest'],
    ['pyproject.toml', `${python} -m pytest -x -q`, 'pytest'],
    ['tox.ini', `${python} -m pytest -x -q`, 'pytest'],
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

/**
 * Single-file components discovered by the walk, as readable script text.
 *
 * Used by `check`'s static pass: a `.vue` file's `<script setup>` holds real
 * tests-or-code the detectors can read, even though mutation cannot write it.
 * Returns `[{ path, script }]` — files without a script block are omitted.
 */
export async function sfcScripts(files) {
  const out = [];
  for (const file of files) {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const script = sfcScript(text);
    if (script && script.trim()) out.push({ path: file, script });
  }
  return out;
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

/** Strip JSONC comments and trailing commas without touching comment-like strings. */
function parseJsonConfig(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 1; }
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (ch === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i += 1; out += '\n'; continue; }
    if (ch === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 1; continue; }
    out += ch;
  }
  try { return JSON.parse(out.replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
}

function normalizeConfigTarget(root, baseUrl, target) {
  return normalisePath(root, resolve(root, baseUrl, target))
    .replace(/\*$/, '');
}

/**
 * Module-resolution hints the project already declares.
 * Without these, `@/lib/f` is recorded as an npm package and every aliased source
 * file looks untested even though its tests run it.
 */
async function projectResolutionHints(root, sources) {
  let config = null;
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    try { config = parseJsonConfig(await readFile(join(root, name), 'utf8')); if (config) break; } catch { /* try next */ }
  }

  const aliases = [];
  const options = config?.compilerOptions ?? {};
  const baseUrl = typeof options.baseUrl === 'string' ? options.baseUrl : '.';
  if (options.paths && typeof options.paths === 'object') {
    for (const [pattern, targets] of Object.entries(options.paths)) {
      if (!Array.isArray(targets)) continue;
      for (const target of targets) {
        if (typeof target !== 'string') continue;
        const star = pattern.indexOf('*');
        aliases.push({
          pattern,
          prefix: star === -1 ? pattern : pattern.slice(0, star),
          suffix: star === -1 ? '' : pattern.slice(star + 1),
          targetPrefix: normalizeConfigTarget(root, baseUrl, target),
        });
      }
    }
  }

  const packages = new Map();
  const roots = [root, ...(await workspaceDirs(root))];
  for (const dir of roots) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
      if (typeof pkg.name === 'string') packages.set(pkg.name, dir);
    } catch { /* not an npm package */ }
  }
  return { aliases, packages };
}

function aliasedKey(spec, aliases) {
  for (const alias of aliases) {
    if (!spec.startsWith(alias.prefix) || !spec.endsWith(alias.suffix)) continue;
    const middle = spec.slice(alias.prefix.length, spec.length - alias.suffix.length);
    return `${alias.targetPrefix}${middle}`.replace(/\/+/g, '/');
  }
  return null;
}

/** Identifiers in executable code, never words inside comments or strings. */
function codeWords(text, file, parsed = undefined) {
  const words = new Set();
  if (isJsFile(file)) {
    const ast = parsed === undefined ? parseJs(text, file).ast : parsed;
    if (!ast) return words;
    walkAst(ast.program, (node) => {
      if ((node.type === 'Identifier' || node.type === 'JSXIdentifier') && typeof node.name === 'string') words.add(node.name);
    });
    return words;
  }

  let cleaned = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      if (ch === '\\') { cleaned += '  '; i += 1; continue; }
      if (ch === quote) quote = null;
      cleaned += ch === '\n' ? '\n' : ' ';
      continue;
    }
    if (ch === '#' && (file.endsWith('.py') || file.endsWith('.rb'))) {
      while (i < text.length && text[i] !== '\n') { cleaned += ' '; i += 1; }
      cleaned += '\n';
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') { cleaned += ' '; i += 1; }
      cleaned += '\n';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cleaned += ch; continue; }
    cleaned += ch;
  }
  for (const match of cleaned.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) words.add(match[0]);
  return words;
}

export async function discover(root) {
  const abs = resolve(root);

  // A file target: audit just that file, in the project that owns it.
  try {
    const info = await stat(abs);
    if (info.isFile()) return discoverFile(abs);
  } catch { /* fall through to directory handling */ }

  const acc = { sourceFiles: [], testFiles: [], sfcFiles: [], truncated: false };
  await walk(abs, abs, acc);

  /** High-confidence coverage: a resolved import, a Go sibling, or the Rust
   * integration-test crate convention. */
  const covers = new Map();
  /** Suggestions only. These never drive mutation scores. */
  const heuristicCovers = new Map();
  const coverEvidence = new Map();
  for (const src of acc.sourceFiles) {
    covers.set(src, []);
    heuristicCovers.set(src, []);
    coverEvidence.set(src, []);
  }

  // Build a lookup from normalised source key to absolute source path. Python
  // src-layout projects import `mypkg.mod`, while the file is `src/mypkg/mod.py`,
  // so the suffix after `/src/` is a second valid lookup key.
  const byKey = new Map();
  const altCandidates = new Map();
  const addAlt = (key, src) => {
    if (!altCandidates.has(key)) altCandidates.set(key, []);
    altCandidates.get(key).push(src);
  };
  for (const src of acc.sourceFiles) {
    const primary = normalisePath(abs, src);
    byKey.set(primary, src);

    const rel = normalizeSlash(relative(abs, src));
    const keys = [];
    const srcMatch = rel.match(/(?:^|\/)src\/(.+)$/);
    if (srcMatch) keys.push(normalisePath(abs, join(abs, srcMatch[1])));
    // `require('../')` / `import '.'` resolve to the directory, whose entry is
    // index.js. Nested index files are already normalised to their directory.
    if (/^index\.[cm]?[jt]sx?$/.test(rel)) keys.push('');
    // Python imports a package, not its __init__ file:
    // `from flask import Flask` executes src/flask/__init__.py.
    if (basename(src) === '__init__.py') {
      keys.push(primary.replace(/\/__init__$/, ''));
      if (srcMatch) keys.push(normalisePath(abs, join(abs, srcMatch[1])).replace(/\/__init__$/, ''));
    }
    for (const key of keys) {
      if (key !== primary) addAlt(key, src);
    }
  }
  const byKeyAlt = new Map();
  for (const [alt, sources] of altCandidates) {
    // Monorepo packages can each contain src/pkg/mod. A suffix that identifies
    // more than one file is not a resolution, so it is left ambiguous rather
    // than sending mutation at the wrong package.
    if (sources.length === 1 && !byKey.has(alt)) byKeyAlt.set(alt, sources[0]);
  }

  const hints = await projectResolutionHints(abs, acc.sourceFiles);
  const sourcesByBase = new Map();
  for (const src of acc.sourceFiles) {
    const base = basename(src).replace(/\.[^.]+$/, '');
    if (base.length < 4) continue;
    if (!sourcesByBase.has(base)) sourcesByBase.set(base, []);
    sourcesByBase.get(base).push(src);
  }

  const record = (source, testFile, reason) => {
    if (!covers.get(source).includes(testFile)) {
      covers.get(source).push(testFile);
      coverEvidence.get(source).push({ test: testFile, reason });
    }
  };

  /** Resolve a module specifier from a test or source file to a known source. */
  const resolveSpecifier = (spec, fromFile, pythonFile) => {
    if (spec.startsWith('node:') || spec.startsWith('http')) return null;
    let key = null;
    let reason = null;

    if (spec.startsWith('.')) {
      const pyStyle = pythonFile && spec.split('/')[0].match(/^\.+(\w.*)$/);
      const resolved = pyStyle
        ? resolve(dirname(fromFile), spec.replace(/^\.+/, '').replace(/\./g, '/'))
        : resolve(dirname(fromFile), spec);
      key = normalisePath(abs, resolved);
      reason = 'relative-import';
    } else if (pythonFile) {
      key = normaliseSpec(spec);
      reason = 'python-import';
    } else {
      const normalized = normaliseJsSpec(spec);
      key = aliasedKey(normalized, hints.aliases);
      reason = key ? 'tsconfig-alias' : null;
      if (!key) {
        for (const [name, dir] of hints.packages) {
          if (spec === name) key = normalisePath(abs, dir);
          else if (spec.startsWith(`${name}/`)) key = normalisePath(abs, join(dir, spec.slice(name.length + 1)));
          if (key) { reason = 'workspace-package'; break; }
        }
      }
      if (!key) { key = normalized; reason = 'bare-import'; }
    }

    const target = byKey.get(key) ?? byKeyAlt.get(key);
    return target ? { target, reason } : null;
  };

  const directTargetsByTest = new Map();

  // Sorted, not readdir order: the covering-test list feeds the cache key and the
  // report, so it must be the same on every run and every machine.
  for (const testFile of [...acc.testFiles].sort()) {
    let text;
    try {
      text = await readFile(testFile, 'utf8');
    } catch {
      continue;
    }

    const parsedAst = isJsFile(testFile) ? parseJs(text, testFile).ast : undefined;
    const specs = referencedSpecifiers(text, testFile, parsedAst);
    const seen = new Set();
    // Python resolves modules by dots (`from lib.mod import x`), JS by slashes.
    // Dots-to-slashes must only apply to python tests: in a JS test,
    // `import _ from 'lodash.merge'` is an npm package, and converting it would
    // falsely map the test onto a local `lodash/merge.js` if one happens to exist.
    const pythonTest = testFile.endsWith('.py');

    const directTargets = [];
    for (const spec of specs) {
      const resolved = resolveSpecifier(spec, testFile, pythonTest);
      if (resolved && !seen.has(resolved.target)) {
        seen.add(resolved.target);
        directTargets.push(resolved.target);
        record(resolved.target, testFile, resolved.reason);
      }
    }
    directTargetsByTest.set(testFile, directTargets);

    // A basename mention is a useful hint but not proof the test executes the file.
    // It is kept out of `covers` because scoring a guessed relation produces
    // survivors no test can explain. Only identifiers in executable code count;
    // words in comments, fixtures or import strings do not.
    const words = codeWords(text, testFile, parsedAst);
    for (const [base, sources] of sourcesByBase) {
      if (!words.has(base)) continue;
      for (const src of sources) {
        if (seen.has(src)) continue;
        if (!heuristicCovers.get(src).includes(testFile)) heuristicCovers.get(src).push(testFile);
      }
    }

    // Go compiles every non-test .go file in a package into the test binary.
    // A file named `binding_test.go` therefore executes all of binding/*.go, not
    // only a same-named binding.go.
    const goTest = normalizeSlash(testFile).match(/^(.*)\/([^/]+)_test\.go$/);
    if (goTest) {
      const [, goDir] = goTest;
      for (const source of acc.sourceFiles) {
        if (!source.endsWith('.go')) continue;
        if (normalizeSlash(dirname(source)) !== normalizeSlash(goDir)) continue;
        if (seen.has(source)) continue;
        seen.add(source);
        directTargets.push(source);
        record(source, testFile, 'go-package-test');
      }
    }

    // Rust's standard integration tests live in `tests/*.rs` and import the crate
    // root. Attribute them to src/lib.rs (or src/main.rs when there is no lib).
    if (/\/tests\/[^/]+\.rs$/.test(normalizeSlash(testFile))) {
      const crate = byKey.get('src/lib.rs') ?? byKey.get('src/main.rs');
      if (crate) {
        seen.add(crate);
        directTargets.push(crate);
        record(crate, testFile, 'rust-integration-test');
      }
    }
    directTargetsByTest.set(testFile, directTargets);
  }

  // Importing a barrel/package entry executes its internal imports. A test of
  // `flask` or `src/index.ts` therefore covers the modules those files load.
  // Cache each source's internal dependency list; closure is per test and cycle safe.
  const dependencyCache = new Map();
  const sourceSet = new Set(acc.sourceFiles);
  const dependenciesOf = async (source) => {
    if (dependencyCache.has(source)) return dependencyCache.get(source);
    let text;
    try { text = await readFile(source, 'utf8'); } catch {
      dependencyCache.set(source, []);
      return [];
    }
    let deps = [];
    if (/\.(?:[cm]?[jt]sx?|py)$/i.test(source)) {
      const parsedAst = isJsFile(source) ? parseJs(text, source).ast : undefined;
      const specs = referencedSpecifiers(text, source, parsedAst);
      deps = [...new Set(specs
        .map((spec) => resolveSpecifier(spec, source, source.endsWith('.py'))?.target)
        .filter((target) => target && sourceSet.has(target) && target !== source))].sort();
    }
    dependencyCache.set(source, deps);
    return deps;
  };

  for (const [testFile, directTargets] of directTargetsByTest) {
    const reached = new Set(directTargets);
    const queue = [...directTargets];
    while (queue.length > 0) {
      const source = queue.shift();
      for (const dependency of await dependenciesOf(source)) {
        if (reached.has(dependency)) continue;
        reached.add(dependency);
        queue.push(dependency);
        record(dependency, testFile, 'transitive-import');
      }
    }
  }

  for (const tests of covers.values()) tests.sort();
  for (const tests of heuristicCovers.values()) tests.sort();

  return {
    root: abs,
    sourceFiles: acc.sourceFiles.sort(),
    testFiles: acc.testFiles.sort(),
    // Single-file components: their `<script>` block is readable JavaScript, so
    // the static pass analyses it. They are NOT mutatable, so they never enter
    // `sourceFiles`; the CLI labels them instead of implying full coverage.
    sfcFiles: acc.sfcFiles.sort(),
    covers,
    heuristicCovers,
    coverEvidence,
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

function normalizeSlash(path) {
  return path.split('\\').join('/');
}
