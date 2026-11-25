export const MAX = 10;

export function isFull(count) {
  return count >= MAX;
}

export function clamp(n, lo, hi) {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

export function label(count) {
  return isFull(count) ? 'full' : 'ok';
}
