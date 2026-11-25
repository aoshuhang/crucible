/**
 * Boundary value synthesis.
 *
 * Pinning `isFull(5)` does not catch `count >= MAX` → `count > MAX`, because 5 is
 * nowhere near the threshold. To kill a boundary mutant you must call the function
 * AT the boundary and just past it.
 *
 * This module derives those probe inputs from the source itself: it reads the
 * comparison, finds the threshold expression, and evaluates candidates around it.
 *
 * This is what separates a real fix from a cosmetic one. Without it, the generated
 * test looks responsible and catches nothing.
 */

/**
 * Extract comparison sites with their operands, from one source file.
 * @returns {{ line: number, op: string, left: string, right: string }[]}
 */
export function comparisonsIn(source) {
  const out = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    if (/\bfor\s*\(/.test(line) || /\bwhile\s*\(/.test(line)) continue;

    const re = /([\w.$\[\]'"]+)\s*(===|!==|==|!=|>=|<=|>|<)\s*([\w.$\[\]'"]+)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      out.push({ line: i + 1, op: m[2], left: m[1], right: m[3] });
    }
  }

  return out;
}

/**
 * Given a comparison, which input values sit exactly on the boundary?
 * We cannot know the function signature in general, so we report the threshold
 * expression and let the fixer look up a numeric value for it.
 * @returns {{ at: number, below: number, above: number } | null}
 */
export function numericThreshold(right) {
  const n = Number(right);
  if (Number.isFinite(n)) return { at: n, below: n - 1, above: n + 1 };
  return null;
}

/**
 * Resolve an identifier to its literal value from the same module.
 * `const MAX = 10;` → 10. Handles `export const` too.
 */
export function resolveConstant(source, name) {
  const re = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*(-?[\\d.]+)\\b`);
  const m = source.match(re);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build boundary probe values for one comparison.
 * Returns the numbers a test must feed in to tell `>=` from `>`.
 */
export function boundaryValues({ comparison, source }) {
  let threshold = numericThreshold(comparison.right);

  if (!threshold) {
    const resolved = resolveConstant(source, comparison.right);
    if (resolved !== null) {
      threshold = { at: resolved, below: resolved - 1, above: resolved + 1 };
    }
  }

  return threshold;
}

/**
 * Does this comparison flip its meaning at the boundary?
 * `>=` vs `>` differ only when both sides are equal, so a test must supply the
 * exact threshold. `>` vs `>=` is the classic off-by-one.
 */
export function boundarySensitive(op) {
  return ['>=', '<=', '>', '<'].includes(op);
}
