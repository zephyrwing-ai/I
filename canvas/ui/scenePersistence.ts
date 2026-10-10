/** Element/resource versions track document edits; view state covers zoom and panning. */
export function shouldPersistCanvasChange(
  previousDocumentVersion: number | undefined,
  documentVersion: number | undefined,
  previousView: Record<string, unknown> | undefined,
  nextView: Record<string, unknown>,
): boolean {
  return documentVersion === undefined || documentVersion !== previousDocumentVersion || !samePersistedView(previousView, nextView);
}

function samePersistedView(currentState: Record<string, unknown> | undefined, nextState: Record<string, unknown>): boolean {
  if (!currentState) return false;
  return currentState.theme === nextState.theme &&
    currentState.viewBackgroundColor === nextState.viewBackgroundColor &&
    currentState.gridSize === nextState.gridSize &&
    currentState.gridStep === nextState.gridStep &&
    (currentState.zoom as { value?: number } | undefined)?.value === (nextState.zoom as { value?: number } | undefined)?.value &&
    currentState.scrollX === nextState.scrollX &&
    currentState.scrollY === nextState.scrollY;
}
