/**
 * Evaluate a Go `//go:build` constraint for the current machine.
 *
 * Mutation runs in the same environment as the project. Auditing a file excluded
 * by the default build (Gin's binding_nomsgpack.go) produces a survivor that no
 * test could ever kill. Unknown custom tags are treated as unset, matching a plain
 * `go test`; `-tags` overrides are deliberately not guessed.
 */

const GOOS = new Set([
  'aix', 'android', 'darwin', 'dragonfly', 'freebsd', 'hurd', 'illumos',
  'ios', 'js', 'linux', 'netbsd', 'openbsd', 'plan9', 'solaris', 'wasip1', 'windows',
]);

const GOARCH = new Set([
  '386', 'amd64', 'arm', 'arm64', 'loong64', 'mips', 'mips64', 'mips64le',
  'mipsle', 'ppc64', 'ppc64le', 'riscv64', 's390x', 'wasm',
]);

function currentGoos() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'darwin';
  return process.platform;
}

function currentGoarch() {
  if (process.arch === 'x64') return 'amd64';
  if (process.arch === 'ia32') return '386';
  if (process.arch === 'arm') return 'arm';
  return process.arch;
}

function atomValue(atom) {
  const goos = currentGoos();
  const goarch = currentGoarch();
  if (GOOS.has(atom)) return atom === goos;
  if (GOARCH.has(atom)) return atom === goarch;
  if (atom === 'unix') return !['windows', 'js', 'plan9', 'wasip1'].includes(goos);
  if (atom === 'cgo') return false;
  if (atom === 'race' || atom === 'msan' || atom === 'asan' || atom === 'gc' || atom === 'gccgo') return false;
  if (/^go1\.\d+$/.test(atom)) return false; // unknown toolchain release; do not guess
  return false; // custom tag not passed on a plain go test
}

function tokenize(expression) {
  return expression.match(/&&|\|\||!|\(|\)|[A-Za-z0-9_.]+/g) ?? [];
}

/** @returns {boolean} true when the file participates in the current build. */
export function goBuildExpressionActive(expression) {
  const tokens = tokenize(expression);
  let index = 0;

  const parseOr = () => {
    let value = parseAnd();
    while (tokens[index] === '||') { index += 1; const right = parseAnd(); value = value || right; }
    return value;
  };
  const parseAnd = () => {
    let value = parseUnary();
    while (tokens[index] === '&&') { index += 1; const right = parseUnary(); value = value && right; }
    return value;
  };
  const parseUnary = () => {
    if (tokens[index] === '!') { index += 1; return !parseUnary(); }
    if (tokens[index] === '(') {
      index += 1;
      const value = parseOr();
      if (tokens[index] === ')') index += 1;
      return value;
    }
    const atom = tokens[index];
    index += 1;
    return atom ? atomValue(atom) : false;
  };

  const value = parseOr();
  return index === tokens.length && value;
}

export function goSourceIsActive(source) {
  const header = source.slice(0, 4096);
  const line = header.match(/^[ \t]*\/\/go:build[ \t]+(.+)$/m);
  if (!line) return true;
  return goBuildExpressionActive(line[1].trim());
}
