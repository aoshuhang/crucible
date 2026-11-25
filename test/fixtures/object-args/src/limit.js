export const MAX_ITEMS = 10;

export function isOverLimit(state) {
  return state.count > MAX_ITEMS;
}

export function canEnter(actor) {
  return actor.level >= 5;
}
