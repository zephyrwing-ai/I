import React from "react";
import { getCommonBounds } from "../element";
import type { NonDeletedExcalidrawElement } from "../element/types";
import { t } from "../i18n";
import {
  sceneCoordsToViewportCoords,
  viewportCoordsToSceneCoords,
} from "../utils";
import {
  getOffscreenContentTarget,
  getOffscreenIndicatorPoint,
} from "../scene/offscreenIndicator";
import type { AppState, PointerCoords, UIAppState } from "../types";

type OffscreenContentIndicatorProps = {
  appState: UIAppState;
  selectedElements: readonly NonDeletedExcalidrawElement[];
  scrollX: number;
  scrollY: number;
  offscreenContentTarget: PointerCoords | null;
  setAppState: React.Component<any, AppState>["setState"];
};

const OffscreenContentIndicator = ({
  appState,
  selectedElements,
  scrollX,
  scrollY,
  offscreenContentTarget,
  setAppState,
}: OffscreenContentIndicatorProps) => {
  const target = getOffscreenContentTarget({
    selectedBounds: selectedElements.length
      ? getCommonBounds(selectedElements)
      : null,
    sceneFallbackTarget: offscreenContentTarget,
    sceneHasNoVisibleElements: appState.scrolledOutside,
    editingText: !!appState.editingTextElement,
    viewport: {
      width: appState.width,
      height: appState.height,
      offsetLeft: appState.offsetLeft,
      offsetTop: appState.offsetTop,
      scrollX,
      scrollY,
      zoom: appState.zoom.value,
    },
  });

  if (!target) {
    return null;
  }

  const zoom = appState.zoom.value;
  const targetViewportPoint = sceneCoordsToViewportCoords(
    { sceneX: target.x, sceneY: target.y },
    {
      zoom: appState.zoom,
      offsetLeft: appState.offsetLeft,
      offsetTop: appState.offsetTop,
      scrollX,
      scrollY,
    },
  );
  const point = getOffscreenIndicatorPoint(
    {
      x: targetViewportPoint.x - appState.offsetLeft,
      y: targetViewportPoint.y - appState.offsetTop,
    },
    { width: appState.width, height: appState.height },
  );

  if (!point) {
    return null;
  }

  const style = {
    left: point.left,
    top: point.top,
    "--offscreen-indicator-rotation": `${point.rotation}deg`,
  } as React.CSSProperties & {
    "--offscreen-indicator-rotation": string;
  };

  return (
    <button
      type="button"
      className="offscreen-content-indicator"
      style={style}
      title={t("buttons.goToOffscreenContent")}
      aria-label={t("buttons.goToOffscreenContent")}
      onClick={() => {
        const viewportCenterInScene = viewportCoordsToSceneCoords(
          {
            clientX: appState.offsetLeft + appState.width / 2,
            clientY: appState.offsetTop + appState.height / 2,
          },
          {
            zoom: appState.zoom,
            offsetLeft: appState.offsetLeft,
            offsetTop: appState.offsetTop,
            scrollX: 0,
            scrollY: 0,
          },
        );
        setAppState({
          scrollX: viewportCenterInScene.x - target!.x,
          scrollY: viewportCenterInScene.y - target!.y,
        });
      }}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" />
      </svg>
    </button>
  );
};

export default React.memo(OffscreenContentIndicator);
