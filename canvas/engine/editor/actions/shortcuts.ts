import { isDarwin } from "../constants";
import { t } from "../i18n";
import type { SubtypeOf } from "../utility-types";
import { getShortcutKey } from "../utils";
import type { ActionName } from "./types";

export type ShortcutName =
  | SubtypeOf<
      ActionName,
      | "toggleTheme"
      | "clearCanvas"
      | "cut"
      | "copy"
      | "paste"
      | "selectAll"
      | "deleteSelectedElements"
      | "duplicateSelection"
      | "sendBackward"
      | "bringForward"
      | "sendToBack"
      | "bringToFront"
      | "copyAsPng"
      | "group"
      | "ungroup"
      | "gridMode"
      | "zenMode"
      | "objectsSnapMode"
      | "viewMode"
      | "flipHorizontal"
      | "flipVertical"
      | "hyperlink"
      | "toggleElementLock"
      | "zoomToFit"
      | "zoomToFitSelectionInViewport"
      | "zoomToFitSelection"
      | "toggleEraserTool"
      | "toggleHandTool"
      | "saveFileToDisk"
      | "saveToActiveFile"
    >
  | "saveScene"
  | "imageExport";

const shortcutMap: Record<ShortcutName, string[]> = {
  toggleTheme: [getShortcutKey("Shift+Alt+D")],
  saveScene: [getShortcutKey("CtrlOrCmd+S")],
  clearCanvas: [getShortcutKey("CtrlOrCmd+Delete")],
  imageExport: [getShortcutKey("CtrlOrCmd+Shift+E")],
  cut: [getShortcutKey("CtrlOrCmd+X")],
  copy: [getShortcutKey("CtrlOrCmd+C")],
  paste: [getShortcutKey("CtrlOrCmd+V")],
  selectAll: [getShortcutKey("CtrlOrCmd+A")],
  deleteSelectedElements: [getShortcutKey("Delete")],
  duplicateSelection: [
    getShortcutKey("CtrlOrCmd+D"),
    getShortcutKey(`Alt+${t("helpDialog.drag")}`),
  ],
  sendBackward: [getShortcutKey("CtrlOrCmd+[")],
  bringForward: [getShortcutKey("CtrlOrCmd+]")],
  sendToBack: [
    isDarwin
      ? getShortcutKey("CtrlOrCmd+Alt+[")
      : getShortcutKey("CtrlOrCmd+Shift+["),
  ],
  bringToFront: [
    isDarwin
      ? getShortcutKey("CtrlOrCmd+Alt+]")
      : getShortcutKey("CtrlOrCmd+Shift+]"),
  ],
  copyAsPng: [getShortcutKey("Shift+Alt+C")],
  group: [getShortcutKey("CtrlOrCmd+G")],
  ungroup: [getShortcutKey("CtrlOrCmd+Shift+G")],
  gridMode: [getShortcutKey("CtrlOrCmd+'")],
  zenMode: [getShortcutKey("Alt+Z")],
  objectsSnapMode: [getShortcutKey("Alt+S")],
  flipHorizontal: [getShortcutKey("Shift+H")],
  flipVertical: [getShortcutKey("Shift+V")],
  viewMode: [getShortcutKey("Alt+R")],
  hyperlink: [getShortcutKey("CtrlOrCmd+K")],
  toggleElementLock: [getShortcutKey("CtrlOrCmd+Shift+L")],
  zoomToFitSelection: [getShortcutKey("Shift+3")],
  zoomToFit: [getShortcutKey("Shift+1")],
  zoomToFitSelectionInViewport: [getShortcutKey("Shift+2")],
  toggleEraserTool: [getShortcutKey("E")],
  toggleHandTool: [getShortcutKey("H")],
  saveFileToDisk: [getShortcutKey("CtrlOrCmd+S")],
  saveToActiveFile: [getShortcutKey("CtrlOrCmd+S")],
};

export const getShortcutFromShortcutName = (name: ShortcutName, idx = 0) => {
  const shortcuts = shortcutMap[name];
  // if multiple shortcuts available, take the first one
  return shortcuts && shortcuts.length > 0
    ? shortcuts[idx] || shortcuts[0]
    : "";
};
