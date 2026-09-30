declare module "@agent-studio/canvas-editor" {
  import type React from "react";

  export const CanvasEditor: React.ComponentType<Record<string, unknown>>;
  export function exportToBlob(options: Record<string, unknown>): Promise<Blob>;
  export function serializeAsJSON(
    elements: readonly import("@agent-studio/canvas-editor/element/types").CanvasEditorElement[],
    appState: import("@agent-studio/canvas-editor/types").AppState,
    files: import("@agent-studio/canvas-editor/types").BinaryFiles,
    type: "local" | "database",
  ): string;
  export function saveAsJSON(
    elements: readonly import("@agent-studio/canvas-editor/element/types").CanvasEditorElement[],
    appState: import("@agent-studio/canvas-editor/types").AppState,
    files: import("@agent-studio/canvas-editor/types").BinaryFiles,
    name?: string,
  ): Promise<{ fileHandle: unknown }>;
  export function getCommonBounds(
    elements: readonly import("@agent-studio/canvas-editor/element/types").CanvasEditorElement[],
    elementsMap?: Map<string, import("@agent-studio/canvas-editor/element/types").CanvasEditorElement>,
  ): [number, number, number, number];
  export function getRotationHandleTopOffset(pointerType: "mouse" | "pen" | "touch", margin?: number, spacing?: number): number;
  export function sceneCoordsToViewportCoords(
    point: { sceneX: number; sceneY: number },
    state: { zoom: { value: number }; offsetLeft: number; offsetTop: number; scrollX: number; scrollY: number },
  ): { x: number; y: number };
}

declare module "@agent-studio/canvas-editor/types" {
  export interface AppState {
    selectedElementIds?: Record<string, boolean>;
    theme?: string;
    viewBackgroundColor?: string;
    gridSize?: number | null;
    gridStep?: number;
    zoom?: { value: number };
    scrollX?: number;
    scrollY?: number;
    offsetLeft?: number;
    offsetTop?: number;
    [key: string]: unknown;
  }

  export type BinaryFiles = Record<string, Record<string, unknown>>;

  export interface CanvasEditorImperativeAPI {
    applyCanvasEdit(
      operations: import("./commands/types").CanvasEditOperation[],
      sourceElements: import("./commands/types").CanvasEditElementRecord[],
      imageFiles?: import("./commands/types").CanvasEditImageFile[],
    ): import("./commands/types").CanvasEditOutcome;
    updateScene(options: { appState?: Partial<AppState> }): void;
    replaceScene(scene: { elements: readonly Record<string, unknown>[]; appState: Partial<AppState>; files: BinaryFiles }): void;
    getSceneElements(): readonly Record<string, unknown>[];
    getSceneVersion(): number | undefined;
    getAppState(): AppState;
    getFiles(): BinaryFiles;
    getName(): string;
    onChange(callback: (elements: readonly Record<string, unknown>[], appState: AppState, files: BinaryFiles) => void): () => void;
  }
}

declare module "@agent-studio/canvas-editor/element/types" {
  export interface CanvasEditorElement {
    id: string;
    isDeleted?: boolean;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    [key: string]: unknown;
  }
}
