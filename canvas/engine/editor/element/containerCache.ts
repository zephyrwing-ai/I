import type { CanvasEditorTextContainer } from "./types";

export const originalContainerCache: {
  [id: CanvasEditorTextContainer["id"]]:
    | {
        height: CanvasEditorTextContainer["height"];
      }
    | undefined;
} = {};

export const updateOriginalContainerCache = (
  id: CanvasEditorTextContainer["id"],
  height: CanvasEditorTextContainer["height"],
) => {
  const data =
    originalContainerCache[id] || (originalContainerCache[id] = { height });
  data.height = height;
  return data;
};

export const resetOriginalContainerCache = (
  id: CanvasEditorTextContainer["id"],
) => {
  if (originalContainerCache[id]) {
    delete originalContainerCache[id];
  }
};

export const getOriginalContainerHeightFromCache = (
  id: CanvasEditorTextContainer["id"],
) => {
  return originalContainerCache[id]?.height ?? null;
};
