/** Canvas elements are JSON records; absent optional properties equal undefined. */
export function canvasEditValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => canvasEditValuesEqual(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) =>
    Object.hasOwn(rightRecord, key) && canvasEditValuesEqual(leftRecord[key], rightRecord[key]));
}

/**
 * Reconcile one synchronous draft against its live input, preserving all fields
 * and the draft's ordering. Unchanged elements retain their live identity so an
 * unrelated pointer gesture or text editor keeps referencing the same object.
 * Deletions are represented by the editor's tombstones, just like other edits.
 */
export function reconcileCanvasEditElements<T extends { id: string }>(
  live: readonly T[],
  draft: readonly T[],
): { elements: T[]; changedIds: Set<string> } {
  const liveById = new Map(live.map((element) => [element.id, element]));
  const changedIds = new Set<string>();
  const elements = draft.map((element) => {
    const previous = liveById.get(element.id);
    if (previous && canvasEditValuesEqual(previous, element)) return previous;
    changedIds.add(element.id);
    return element;
  });
  return { elements, changedIds };
}
