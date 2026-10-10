import React from "react";
import { InitializeApp } from "./components/InitializeApp";
import App from "./components/App";
import { isShallowEqual } from "./utils";

import "./css/app.scss";
import "./css/styles.scss";
import "./fonts/fonts.css";

import type { AppProps, CanvasEditorProps } from "./types";
import { defaultLang } from "./i18n";
import { DEFAULT_UI_OPTIONS } from "./constants";
import { EditorJotaiProvider, editorJotaiStore } from "./editor-jotai";
import Footer from "./components/footer/FooterCenter";
import WelcomeScreen from "./components/welcome-screen/WelcomeScreen";

const CanvasEditorBase = (props: CanvasEditorProps) => {
  const {
    onChange,
    initialData,
    canvasAPI,
    renderTopRightUI,
    langCode = defaultLang.code,
    viewModeEnabled,
    zenModeEnabled,
    gridModeEnabled,
    theme,
    name,
    onPaste,
    detectScroll = true,
    handleKeyboardGlobally = false,
    autoFocus = false,
    generateIdForFile,
    onLinkOpen,
    generateLinkForSelection,
    onPointerDown,
    onPointerUp,
    onScrollChange,
    onDuplicate,
    children,
  } = props;

  const canvasActions = props.UIOptions?.canvasActions;

  // FIXME normalize/set defaults in parent component so that the memo resolver
  // compares the same values
  const UIOptions: AppProps["UIOptions"] = {
    ...props.UIOptions,
    canvasActions: {
      ...DEFAULT_UI_OPTIONS.canvasActions,
      ...canvasActions,
    },
    tools: {
      image: props.UIOptions?.tools?.image ?? true,
    },
  };

  if (canvasActions?.export) {
    UIOptions.canvasActions.export.saveFileToDisk =
      canvasActions.export?.saveFileToDisk ??
      DEFAULT_UI_OPTIONS.canvasActions.export.saveFileToDisk;
  }

  if (
    UIOptions.canvasActions.toggleTheme === null &&
    typeof theme === "undefined"
  ) {
    UIOptions.canvasActions.toggleTheme = true;
  }
  return (
    <EditorJotaiProvider store={editorJotaiStore}>
      <InitializeApp langCode={langCode} theme={theme}>
        <App
          onChange={onChange}
          initialData={initialData}
          canvasAPI={canvasAPI}
          renderTopRightUI={renderTopRightUI}
          langCode={langCode}
          viewModeEnabled={viewModeEnabled}
          zenModeEnabled={zenModeEnabled}
          gridModeEnabled={gridModeEnabled}
          theme={theme}
          name={name}
          UIOptions={UIOptions}
          onPaste={onPaste}
          detectScroll={detectScroll}
          handleKeyboardGlobally={handleKeyboardGlobally}
          autoFocus={autoFocus}
          generateIdForFile={generateIdForFile}
          onLinkOpen={onLinkOpen}
          generateLinkForSelection={generateLinkForSelection}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onScrollChange={onScrollChange}
          onDuplicate={onDuplicate}
        >
          {children}
        </App>
      </InitializeApp>
    </EditorJotaiProvider>
  );
};

const areEqual = (prevProps: CanvasEditorProps, nextProps: CanvasEditorProps) => {
  // short-circuit early
  if (prevProps.children !== nextProps.children) {
    return false;
  }

  const {
    initialData: prevInitialData,
    UIOptions: prevUIOptions = {},
    ...prev
  } = prevProps;
  const {
    initialData: nextInitialData,
    UIOptions: nextUIOptions = {},
    ...next
  } = nextProps;

  // comparing UIOptions
  const prevUIOptionsKeys = Object.keys(prevUIOptions) as (keyof Partial<
    typeof DEFAULT_UI_OPTIONS
  >)[];
  const nextUIOptionsKeys = Object.keys(nextUIOptions) as (keyof Partial<
    typeof DEFAULT_UI_OPTIONS
  >)[];

  if (prevUIOptionsKeys.length !== nextUIOptionsKeys.length) {
    return false;
  }

  const isUIOptionsSame = prevUIOptionsKeys.every((key) => {
    if (key === "canvasActions") {
      const canvasOptionKeys = Object.keys(
        prevUIOptions.canvasActions!,
      ) as (keyof Partial<typeof DEFAULT_UI_OPTIONS.canvasActions>)[];
      return canvasOptionKeys.every((key) => {
        if (
          key === "export" &&
          prevUIOptions?.canvasActions?.export &&
          nextUIOptions?.canvasActions?.export
        ) {
          return (
            prevUIOptions.canvasActions.export.saveFileToDisk ===
            nextUIOptions.canvasActions.export.saveFileToDisk
          );
        }
        return (
          prevUIOptions?.canvasActions?.[key] ===
          nextUIOptions?.canvasActions?.[key]
        );
      });
    }
    return prevUIOptions[key] === nextUIOptions[key];
  });

  return isUIOptionsSame && isShallowEqual(prev, next);
};

export const CanvasEditor = React.memo(CanvasEditorBase, areEqual);
CanvasEditor.displayName = "CanvasEditor";

export {
  getSceneVersion,
  hashElementsVersion,
  hashString,
  isInvisiblySmallElement,
  getNonDeletedElements,
  getTextFromElements,
} from "./element";
export { defaultLang, useI18n, languages } from "./i18n";
export {
  restore,
  restoreAppState,
  restoreElements,
} from "./data/restore";

export { reconcileElements } from "./data/reconcile";

export {
  exportToCanvas,
  exportToBlob,
  exportToSvg,
  exportToClipboard,
} from "@agent-studio/canvas-utils/export";

export { serializeAsJSON } from "./data/json";
export { saveAsJSON } from "./data/json";
export { loadFromBlob } from "./data/blob";
export { getFreeDrawSvgPath } from "./renderer/renderElement";
export { isLinearElement } from "./element/typeChecks";

export {
  FONT_FAMILY,
  THEME,
  MIME_TYPES,
  ROUNDNESS,
  DEFAULT_LASER_COLOR,
} from "./constants";

export {
  mutateElement,
  newElementWith,
  bumpVersion,
} from "./element/mutateElement";

export { CaptureUpdateAction } from "./store";


export {
  sceneCoordsToViewportCoords,
  viewportCoordsToSceneCoords,
} from "./utils";

export { Sidebar } from "./components/Sidebar/Sidebar";
export { Button } from "./components/Button";
export { Footer };
export { useDevice } from "./components/App";
export { WelcomeScreen };

export { normalizeLink } from "./data/url";
export { zoomToFitBounds } from "./actions/actionCanvas";
export { convertToCanvasEditorElements } from "./data/transform";
export { getCommonBounds, getVisibleSceneBounds } from "./element/bounds";
export { getRotationHandleTopOffset } from "./element/transformHandles";

export {
  elementsOverlappingBBox,
  isElementInsideBBox,
  elementPartiallyOverlapsWithOrContainsBBox,
} from "@agent-studio/canvas-utils/withinBounds";

export { getDataURL } from "./data/blob";
export { isElementLink } from "./element/elementLink";

export { setCustomTextMetricsProvider } from "./element/textMeasurements";
