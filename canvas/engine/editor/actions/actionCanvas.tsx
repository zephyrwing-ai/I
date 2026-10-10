import { useEffect, useRef, useState } from "react";
import {
  handIcon,
  MoonIcon,
  SunIcon,
  TrashIcon,
  zoomAreaIcon,
} from "../components/icons";
import { ToolButton } from "../components/ToolButton";
import {
  CURSOR_TYPE,
  MAX_ZOOM,
  MIN_ZOOM,
  THEME,
  ZOOM_STEP,
} from "../constants";
import { getCommonBounds, getNonDeletedElements } from "../element";
import type { CanvasEditorElement } from "../element/types";
import { t } from "../i18n";
import { CODES, KEYS } from "../keys";
import { getNormalizedZoom } from "../scene";
import { centerScrollOn } from "../scene/scroll";
import { getStateForZoom } from "../scene/zoom";
import type { AppState, Offsets } from "../types";
import { updateActiveTool } from "../utils";
import { register } from "./register";
import { Tooltip } from "../components/Tooltip";
import { newElementWith } from "../element/mutateElement";
import {
  getDefaultAppState,
  isEraserActive,
  isHandToolActive,
} from "../appState";
import type { SceneBounds } from "../element/bounds";
import { setCursor } from "../cursor";
import { CaptureUpdateAction } from "../store";
import { clamp, roundToStep } from "@agent-studio/canvas-math";
import {
  formatZoomPercentage,
  parseZoomPercentage,
} from "./zoomInput";

export const actionClearCanvas = register({
  name: "clearCanvas",
  label: "labels.clearCanvas",
  paletteName: "Clear canvas",
  icon: TrashIcon,
  predicate: (elements, appState, props, app) => {
    return (
      !!app.props.UIOptions.canvasActions.clearCanvas &&
      !appState.viewModeEnabled &&
      appState.openDialog?.name !== "elementLinkSelector"
    );
  },
  perform: (elements, appState, _, app) => {
    app.imageCache.clear();
    return {
      elements: elements.map((element) =>
        newElementWith(element, { isDeleted: true }),
      ),
      appState: {
        ...getDefaultAppState(),
        files: {},
        theme: appState.theme,
        penMode: appState.penMode,
        penDetected: appState.penDetected,
        exportBackground: appState.exportBackground,
        exportEmbedScene: appState.exportEmbedScene,
        gridSize: appState.gridSize,
        gridStep: appState.gridStep,
        gridModeEnabled: appState.gridModeEnabled,
        activeTool:
          appState.activeTool.type === "image"
            ? { ...appState.activeTool, type: "selection" }
            : appState.activeTool,
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
});

const ZoomControl = ({
  zoom,
  updateData,
}: {
  zoom: number;
  updateData: (percentage?: number) => void;
}) => {
  const [draft, setDraft] = useState(() => formatZoomPercentage(zoom));
  const editingRef = useRef(false);
  const editedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editingRef.current) {
      setDraft(formatZoomPercentage(zoom));
    }
  }, [zoom]);

  const commit = () => {
    if (!editingRef.current) {
      return;
    }
    editingRef.current = false;
    if (!editedRef.current) {
      setDraft(formatZoomPercentage(zoom));
      return;
    }
    editedRef.current = false;

    const percentage = parseZoomPercentage(draft);
    if (percentage === null) {
      setDraft(formatZoomPercentage(zoom));
      return;
    }

    const clampedPercentage = clamp(
      percentage,
      MIN_ZOOM * 100,
      MAX_ZOOM * 100,
    );
    setDraft(formatZoomPercentage(clampedPercentage / 100));
    if (Math.abs(clampedPercentage / 100 - zoom) > 0.000001) {
      updateData(clampedPercentage);
    }
  };

  const cancel = () => {
    editingRef.current = false;
    editedRef.current = false;
    setDraft(formatZoomPercentage(zoom));
    inputRef.current?.blur();
  };

  return (
    <div className="zoom-control" title={t("labels.zoom")}>
      <input
        ref={inputRef}
        className="zoom-control__input"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        value={draft}
        aria-label={t("labels.zoom")}
        onFocus={() => {
          editingRef.current = true;
          editedRef.current = false;
          setDraft(formatZoomPercentage(zoom));
          inputRef.current?.select();
        }}
        onChange={(event) => {
          editedRef.current = true;
          setDraft(event.target.value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
            inputRef.current?.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
        }}
      />
    </div>
  );
};

export const actionSetZoom = register({
  name: "setZoom",
  label: "labels.zoom",
  viewMode: true,
  perform: (_elements, appState, percentage: number) => {
    if (!Number.isFinite(percentage)) {
      return false;
    }
    const nextZoom = getNormalizedZoom(
      clamp(percentage / 100, MIN_ZOOM, MAX_ZOOM),
    );
    return {
      appState: {
        ...appState,
        ...getStateForZoom(
          {
            viewportX: appState.width / 2 + appState.offsetLeft,
            viewportY: appState.height / 2 + appState.offsetTop,
            nextZoom,
          },
          appState,
        ),
      },
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    };
  },
  PanelComponent: ({ updateData, appState }) => (
    <ZoomControl
      zoom={appState.zoom.value}
      updateData={updateData}
    />
  ),
});

const zoomValueToFitBoundsOnViewport = (
  bounds: SceneBounds,
  viewportDimensions: { width: number; height: number },
  viewportZoomFactor: number = 1, // default to 1 if not provided
) => {
  const [x1, y1, x2, y2] = bounds;
  const commonBoundsWidth = x2 - x1;
  const zoomValueForWidth = viewportDimensions.width / commonBoundsWidth;
  const commonBoundsHeight = y2 - y1;
  const zoomValueForHeight = viewportDimensions.height / commonBoundsHeight;
  const smallestZoomValue = Math.min(zoomValueForWidth, zoomValueForHeight);

  const adjustedZoomValue =
    smallestZoomValue * clamp(viewportZoomFactor, 0.1, 1);

  return Math.min(adjustedZoomValue, 1);
};

export const zoomToFitBounds = ({
  bounds,
  appState,
  canvasOffsets,
  fitToViewport = false,
  viewportZoomFactor = 1,
  minZoom = -Infinity,
  maxZoom = Infinity,
}: {
  bounds: SceneBounds;
  canvasOffsets?: Offsets;
  appState: Readonly<AppState>;
  /** whether to fit content to viewport (beyond >100%) */
  fitToViewport: boolean;
  /** zoom content to cover X of the viewport, when fitToViewport=true */
  viewportZoomFactor?: number;
  minZoom?: number;
  maxZoom?: number;
}) => {
  viewportZoomFactor = clamp(viewportZoomFactor, MIN_ZOOM, MAX_ZOOM);

  const [x1, y1, x2, y2] = bounds;
  const centerX = (x1 + x2) / 2;
  const centerY = (y1 + y2) / 2;

  const canvasOffsetLeft = canvasOffsets?.left ?? 0;
  const canvasOffsetTop = canvasOffsets?.top ?? 0;
  const canvasOffsetRight = canvasOffsets?.right ?? 0;
  const canvasOffsetBottom = canvasOffsets?.bottom ?? 0;

  const effectiveCanvasWidth =
    appState.width - canvasOffsetLeft - canvasOffsetRight;
  const effectiveCanvasHeight =
    appState.height - canvasOffsetTop - canvasOffsetBottom;

  let adjustedZoomValue;

  if (fitToViewport) {
    const commonBoundsWidth = x2 - x1;
    const commonBoundsHeight = y2 - y1;

    adjustedZoomValue =
      Math.min(
        effectiveCanvasWidth / commonBoundsWidth,
        effectiveCanvasHeight / commonBoundsHeight,
      ) * viewportZoomFactor;
  } else {
    adjustedZoomValue = zoomValueToFitBoundsOnViewport(
      bounds,
      {
        width: effectiveCanvasWidth,
        height: effectiveCanvasHeight,
      },
      viewportZoomFactor,
    );
  }

  const newZoomValue = getNormalizedZoom(
    clamp(roundToStep(adjustedZoomValue, ZOOM_STEP, "floor"), minZoom, maxZoom),
  );

  const centerScroll = centerScrollOn({
    scenePoint: { x: centerX, y: centerY },
    viewportDimensions: {
      width: appState.width,
      height: appState.height,
    },
    offsets: canvasOffsets,
    zoom: { value: newZoomValue },
  });

  return {
    appState: {
      ...appState,
      scrollX: centerScroll.scrollX,
      scrollY: centerScroll.scrollY,
      zoom: { value: newZoomValue },
    },
    captureUpdate: CaptureUpdateAction.EVENTUALLY,
  };
};

export const zoomToFit = ({
  canvasOffsets,
  targetElements,
  appState,
  fitToViewport,
  viewportZoomFactor,
  minZoom,
  maxZoom,
}: {
  canvasOffsets?: Offsets;
  targetElements: readonly CanvasEditorElement[];
  appState: Readonly<AppState>;
  /** whether to fit content to viewport (beyond >100%) */
  fitToViewport: boolean;
  /** zoom content to cover X of the viewport, when fitToViewport=true */
  viewportZoomFactor?: number;
  minZoom?: number;
  maxZoom?: number;
}) => {
  const commonBounds = getCommonBounds(getNonDeletedElements(targetElements));

  return zoomToFitBounds({
    canvasOffsets,
    bounds: commonBounds,
    appState,
    fitToViewport,
    viewportZoomFactor,
    minZoom,
    maxZoom,
  });
};

// Note, this action differs from actionZoomToFitSelection in that it doesn't
// zoom beyond 100%. In other words, if the content is smaller than viewport
// size, it won't be zoomed in.
export const actionZoomToFitSelectionInViewport = register({
  name: "zoomToFitSelectionInViewport",
  label: "labels.zoomToFitViewport",
  icon: zoomAreaIcon,
  perform: (elements, appState, _, app) => {
    const selectedElements = app.scene.getSelectedElements(appState);
    return zoomToFit({
      targetElements: selectedElements.length ? selectedElements : elements,
      appState: {
        ...appState,
      },
      fitToViewport: false,
      canvasOffsets: app.getEditorUIOffsets(),
    });
  },
  // NOTE shift-2 should have been assigned actionZoomToFitSelection.
  // TBD on how proceed
  keyTest: (event) =>
    event.code === CODES.TWO &&
    event.shiftKey &&
    !event.altKey &&
    !event[KEYS.CTRL_OR_CMD],
});

export const actionZoomToFitSelection = register({
  name: "zoomToFitSelection",
  label: "helpDialog.zoomToSelection",
  icon: zoomAreaIcon,
  perform: (elements, appState, _, app) => {
    const selectedElements = app.scene.getSelectedElements(appState);
    return zoomToFit({
      targetElements: selectedElements.length ? selectedElements : elements,
      appState: {
        ...appState,
      },
      fitToViewport: true,
      canvasOffsets: app.getEditorUIOffsets(),
    });
  },
  // NOTE this action should use shift-2 per figma, alas
  keyTest: (event) =>
    event.code === CODES.THREE &&
    event.shiftKey &&
    !event.altKey &&
    !event[KEYS.CTRL_OR_CMD],
});

export const actionZoomToFit = register({
  name: "zoomToFit",
  label: "helpDialog.zoomToFit",
  icon: zoomAreaIcon,
  viewMode: true,
  perform: (elements, appState, _, app) =>
    zoomToFit({
      targetElements: elements,
      appState: {
        ...appState,
      },
      fitToViewport: false,
      canvasOffsets: app.getEditorUIOffsets(),
    }),
  keyTest: (event) =>
    event.code === CODES.ONE &&
    event.shiftKey &&
    !event.altKey &&
    !event[KEYS.CTRL_OR_CMD],
});

export const actionToggleTheme = register({
  name: "toggleTheme",
  label: (_, appState) => {
    return appState.theme === THEME.DARK
      ? "buttons.lightMode"
      : "buttons.darkMode";
  },
  keywords: ["toggle", "dark", "light", "mode", "theme"],
  icon: (appState) => (appState.theme === THEME.LIGHT ? MoonIcon : SunIcon),
  viewMode: true,
  perform: (_, appState, value) => {
    return {
      appState: {
        ...appState,
        theme:
          value || (appState.theme === THEME.LIGHT ? THEME.DARK : THEME.LIGHT),
      },
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    };
  },
  keyTest: (event) => event.altKey && event.shiftKey && event.code === CODES.D,
  predicate: (elements, appState, props, app) => {
    return !!app.props.UIOptions.canvasActions.toggleTheme;
  },
});

export const actionToggleEraserTool = register({
  name: "toggleEraserTool",
  label: "toolBar.eraser",
  perform: (elements, appState) => {
    let activeTool: AppState["activeTool"];

    if (isEraserActive(appState)) {
      activeTool = updateActiveTool(appState, {
        ...(appState.activeTool.lastActiveTool || {
          type: "selection",
        }),
        lastActiveToolBeforeEraser: null,
      });
    } else {
      activeTool = updateActiveTool(appState, {
        type: "eraser",
        lastActiveToolBeforeEraser: appState.activeTool,
      });
    }

    return {
      appState: {
        ...appState,
        selectedElementIds: {},
        selectedGroupIds: {},
        activeTool,
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
  keyTest: (event) => event.key === KEYS.E,
});

export const actionToggleHandTool = register({
  name: "toggleHandTool",
  label: "toolBar.hand",
  paletteName: "Toggle hand tool",
  icon: handIcon,
  viewMode: false,
  perform: (elements, appState, _, app) => {
    let activeTool: AppState["activeTool"];

    if (isHandToolActive(appState)) {
      activeTool = updateActiveTool(appState, {
        ...(appState.activeTool.lastActiveTool || {
          type: "selection",
        }),
        lastActiveToolBeforeEraser: null,
      });
    } else {
      activeTool = updateActiveTool(appState, {
        type: "hand",
        lastActiveToolBeforeEraser: appState.activeTool,
      });
      setCursor(app.interactiveCanvas, CURSOR_TYPE.GRAB);
    }

    return {
      appState: {
        ...appState,
        selectedElementIds: {},
        selectedGroupIds: {},
        activeTool,
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
  keyTest: (event) =>
    !event.altKey && !event[KEYS.CTRL_OR_CMD] && event.key === KEYS.H,
});
