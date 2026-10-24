import type { CanvasEditorElement } from "../element/types";
import type { AppState } from "../types";
import type { ActionName } from "./types";

type EditScope = "none" | "selection" | "groups" | "scene" | "locked" | "finalize";

/** Every action declares whether it can acquire or change document elements. */
const actionEditScopes: Record<ActionName, EditScope> = {
  copy: "none",
  cut: "selection",
  paste: "none", // insertion validates its actual targets after clipboard parsing
  copyAsPng: "none",
  copyAsSvg: "none",
  copyText: "none",
  sendBackward: "selection",
  bringForward: "selection",
  sendToBack: "selection",
  bringToFront: "selection",
  selectAll: "none",
  gridMode: "none",
  zenMode: "none",
  objectsSnapMode: "none",
  undo: "none", // History guards its next increment, independently of selection
  redo: "none",
  finalize: "finalize",
  changeProjectName: "none",
  changeExportBackground: "none",
  changeExportEmbedScene: "none",
  changeExportScale: "none",
  saveToActiveFile: "none",
  saveFileToDisk: "none",
  duplicateSelection: "selection",
  deleteSelectedElements: "selection",
  clearCanvas: "scene",
  setZoom: "none",
  zoomToFit: "none",
  zoomToFitSelection: "none",
  zoomToFitSelectionInViewport: "none",
  toggleFullScreen: "none",
  group: "selection",
  ungroup: "groups",
  alignTop: "selection",
  alignBottom: "selection",
  alignLeft: "selection",
  alignRight: "selection",
  alignVerticallyCentered: "selection",
  alignHorizontallyCentered: "selection",
  distributeHorizontally: "selection",
  distributeVertically: "selection",
  flipHorizontal: "selection",
  flipVertical: "selection",
  viewMode: "none",
  exportWithDarkMode: "none",
  toggleTheme: "none",
  unbindText: "selection",
  hyperlink: "selection",
  bindText: "selection",
  unlockAllElements: "locked",
  toggleElementLock: "selection",
  toggleLinearEditor: "selection",
  toggleEraserTool: "none",
  toggleHandTool: "none",
  selectAllElementsInFrame: "none",
  removeAllElementsFromFrame: "selection",
  updateFrameRendering: "none",
  createContainerFromText: "selection",
  wrapTextInContainer: "selection",
  autoResize: "selection",
  copyElementLink: "none",
  linkToElement: "selection",
  cropEditor: "selection",
};

/** Primary write targets. The editor expands bindings/frames at its permission boundary. */
export function getActionHumanEditTargets(
  name: ActionName,
  elements: readonly CanvasEditorElement[],
  appState: Pick<
    AppState,
    | "selectedElementIds"
    | "selectedGroupIds"
    | "editingLinearElement"
    | "multiElement"
    | "newElement"
    | "pendingImageElementId"
  >,
): Set<string> | null {
  switch (actionEditScopes[name]) {
    case "none":
      return null;
    case "scene":
      return new Set(elements.map((element) => element.id));
    case "locked":
      return new Set(elements.filter((element) => element.locked).map((element) => element.id));
    case "groups":
      return new Set(
        elements.filter((element) => element.groupIds.some((id) => appState.selectedGroupIds[id]))
          .map((element) => element.id),
      );
    case "selection": {
      const ids = new Set(
        Object.keys(appState.selectedElementIds).filter((id) => appState.selectedElementIds[id]),
      );
      if (
        appState.editingLinearElement &&
        (name === "deleteSelectedElements" || name === "cut" || name === "duplicateSelection")
      ) {
        ids.add(appState.editingLinearElement.elementId);
      }
      return ids;
    }
    case "finalize": {
      // Finalization belongs to the ongoing gesture, not an unrelated selection.
      if (appState.editingLinearElement) {
        return new Set([appState.editingLinearElement.elementId]);
      }
      const ids = new Set<string>();
      if (appState.pendingImageElementId) {
        ids.add(appState.pendingImageElementId);
      }
      const multiElement = appState.multiElement ||
        (appState.newElement?.type === "freedraw" ? appState.newElement : null);
      if (multiElement) {
        ids.add(multiElement.id);
      }
      return ids;
    }
  }
}
