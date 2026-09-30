import type { AppState } from "../types";
import { sceneCoordsToViewportCoords } from "../utils";
import type { ElementsMap, NonDeletedCanvasEditorElement } from "./types";
import { getElementAbsoluteCoords } from ".";
import { useCanvasEditorAppState } from "../components/App";

import "./ElementCanvasButtons.scss";

const CONTAINER_PADDING = 5;

const getContainerCoords = (
  element: NonDeletedCanvasEditorElement,
  appState: AppState,
  elementsMap: ElementsMap,
) => {
  const [x1, y1] = getElementAbsoluteCoords(element, elementsMap);
  const { x: viewportX, y: viewportY } = sceneCoordsToViewportCoords(
    { sceneX: x1 + element.width, sceneY: y1 },
    appState,
  );
  const x = viewportX - appState.offsetLeft + 10;
  const y = viewportY - appState.offsetTop;
  return { x, y };
};

export const ElementCanvasButtons = ({
  children,
  element,
  elementsMap,
}: {
  children: React.ReactNode;
  element: NonDeletedCanvasEditorElement;
  elementsMap: ElementsMap;
}) => {
  const appState = useCanvasEditorAppState();

  if (
    appState.contextMenu ||
    appState.newElement ||
    appState.resizingElement ||
    appState.isRotating ||
    appState.viewModeEnabled
  ) {
    return null;
  }

  const { x, y } = getContainerCoords(element, appState, elementsMap);

  return (
    <div
      className="agent-canvas-canvas-buttons"
      style={{
        top: `${y}px`,
        left: `${x}px`,
        // width: CONTAINER_WIDTH,
        padding: CONTAINER_PADDING,
      }}
    >
      {children}
    </div>
  );
};
