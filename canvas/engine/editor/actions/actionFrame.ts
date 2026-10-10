import { getNonDeletedElements } from "../element";
import type { CanvasEditorElement } from "../element/types";
import { removeAllElementsFromFrame } from "../frame";
import { getFrameChildren } from "../frame";
import type { AppClassProperties, AppState, UIAppState } from "../types";
import { register } from "./register";
import { isFrameLikeElement } from "../element/typeChecks";
import { CaptureUpdateAction } from "../store";

const isSingleFrameSelected = (
  appState: UIAppState,
  app: AppClassProperties,
) => {
  const selectedElements = app.scene.getSelectedElements(appState);

  return (
    selectedElements.length === 1 && isFrameLikeElement(selectedElements[0])
  );
};

export const actionSelectAllElementsInFrame = register({
  name: "selectAllElementsInFrame",
  label: "labels.selectAllElementsInFrame",
  perform: (elements, appState, _, app) => {
    const selectedElement =
      app.scene.getSelectedElements(appState).at(0) || null;

    if (isFrameLikeElement(selectedElement)) {
      const elementsInFrame = getFrameChildren(
        getNonDeletedElements(elements),
        selectedElement.id,
      ).filter((element) => !(element.type === "text" && element.containerId));

      return {
        elements,
        appState: {
          ...appState,
          selectedElementIds: elementsInFrame.reduce((acc, element) => {
            acc[element.id] = true;
            return acc;
          }, {} as Record<CanvasEditorElement["id"], true>),
        },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      };
    }

    return {
      elements,
      appState,
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    };
  },
  predicate: (elements, appState, _, app) =>
    isSingleFrameSelected(appState, app),
});

export const actionRemoveAllElementsFromFrame = register({
  name: "removeAllElementsFromFrame",
  label: "labels.removeAllElementsFromFrame",
  perform: (elements, appState, _, app) => {
    const selectedElement =
      app.scene.getSelectedElements(appState).at(0) || null;

    if (isFrameLikeElement(selectedElement)) {
      return {
        elements: removeAllElementsFromFrame(elements, selectedElement),
        appState: {
          ...appState,
          selectedElementIds: {
            [selectedElement.id]: true,
          },
        },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      };
    }

    return {
      elements,
      appState,
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    };
  },
  predicate: (elements, appState, _, app) =>
    isSingleFrameSelected(appState, app),
});

export const actionupdateFrameRendering = register({
  name: "updateFrameRendering",
  label: "labels.updateFrameRendering",
  viewMode: true,
  perform: (elements, appState) => {
    return {
      elements,
      appState: {
        ...appState,
        frameRendering: {
          ...appState.frameRendering,
          enabled: !appState.frameRendering.enabled,
        },
      },
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    };
  },
  checked: (appState: AppState) => appState.frameRendering.enabled,
});
