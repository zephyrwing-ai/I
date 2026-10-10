import type React from "react";
import type {
  CanvasEditorElement,
  OrderedCanvasEditorElement,
} from "../element/types";
import type {
  AppClassProperties,
  AppState,
  CanvasEditorProps,
  BinaryFiles,
  UIAppState,
} from "../types";
import type { CaptureUpdateActionType } from "../store";

/** if false, the action should be prevented */
export type ActionResult =
  | {
      elements?: readonly CanvasEditorElement[] | null;
      appState?: Partial<AppState> | null;
      files?: BinaryFiles | null;
      captureUpdate: CaptureUpdateActionType;
      replaceFiles?: boolean;
    }
  | false;

type ActionFn = (
  elements: readonly OrderedCanvasEditorElement[],
  appState: Readonly<AppState>,
  formData: any,
  app: AppClassProperties,
) => ActionResult | Promise<ActionResult>;

export type UpdaterFn = (res: ActionResult) => void;
export type ActionFilterFn = (action: Action) => void;

export type ActionName =
  | "copy"
  | "cut"
  | "paste"
  | "copyAsPng"
  | "copyAsSvg"
  | "copyText"
  | "sendBackward"
  | "bringForward"
  | "sendToBack"
  | "bringToFront"
  | "selectAll"
  | "gridMode"
  | "zenMode"
  | "objectsSnapMode"
  | "undo"
  | "redo"
  | "finalize"
  | "changeProjectName"
  | "changeExportBackground"
  | "changeExportEmbedScene"
  | "changeExportScale"
  | "saveToActiveFile"
  | "saveFileToDisk"
  | "duplicateSelection"
  | "deleteSelectedElements"
  | "clearCanvas"
  | "setZoom"
  | "zoomToFit"
  | "zoomToFitSelection"
  | "zoomToFitSelectionInViewport"
  | "toggleFullScreen"
  | "group"
  | "ungroup"
  | "alignTop"
  | "alignBottom"
  | "alignLeft"
  | "alignRight"
  | "alignVerticallyCentered"
  | "alignHorizontallyCentered"
  | "distributeHorizontally"
  | "distributeVertically"
  | "flipHorizontal"
  | "flipVertical"
  | "viewMode"
  | "exportWithDarkMode"
  | "toggleTheme"
  | "unbindText"
  | "hyperlink"
  | "bindText"
  | "unlockAllElements"
  | "toggleElementLock"
  | "toggleLinearEditor"
  | "toggleEraserTool"
  | "toggleHandTool"
  | "selectAllElementsInFrame"
  | "removeAllElementsFromFrame"
  | "updateFrameRendering"
  | "createContainerFromText"
  | "wrapTextInContainer"
  | "autoResize"
  | "copyElementLink"
  | "linkToElement"
  | "cropEditor";

export type PanelComponentProps = {
  elements: readonly CanvasEditorElement[];
  appState: AppState;
  updateData: <T = any>(formData?: T) => void;
  appProps: CanvasEditorProps;
  data?: Record<string, any>;
  app: AppClassProperties;
};

export interface Action {
  name: ActionName;
  label:
    | string
    | ((
        elements: readonly CanvasEditorElement[],
        appState: Readonly<AppState>,
        app: AppClassProperties,
      ) => string);
  keywords?: string[];
  icon?:
    | React.ReactNode
    | ((
        appState: UIAppState,
        elements: readonly CanvasEditorElement[],
      ) => React.ReactNode);
  PanelComponent?: React.FC<PanelComponentProps>;
  perform: ActionFn;
  keyPriority?: number;
  keyTest?: (
    event: React.KeyboardEvent | KeyboardEvent,
    appState: AppState,
    elements: readonly CanvasEditorElement[],
    app: AppClassProperties,
  ) => boolean;
  predicate?: (
    elements: readonly CanvasEditorElement[],
    appState: AppState,
    appProps: CanvasEditorProps,
    app: AppClassProperties,
  ) => boolean;
  checked?: (appState: Readonly<AppState>) => boolean;
  /** if set to `true`, allow action to be performed in viewMode.
   *  Defaults to `false` */
  viewMode?: boolean;
}
