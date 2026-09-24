declare module "@agent-studio/canvas-editor" {
  import type React from "react";

  export const Excalidraw: React.ComponentType<Record<string, unknown>>;
  export function exportToBlob(options: Record<string, unknown>): Promise<Blob>;
  export function saveAsJSON(
    elements: readonly import("@agent-studio/canvas-editor/element/types").ExcalidrawElement[],
    appState: import("@agent-studio/canvas-editor/types").AppState,
    files: import("@agent-studio/canvas-editor/types").BinaryFiles,
    name?: string,
  ): Promise<{ fileHandle: unknown }>;
  export function getCommonBounds(elements: readonly import("@agent-studio/canvas-editor/element/types").ExcalidrawElement[]): [number, number, number, number];
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

  export interface ExcalidrawImperativeAPI {
    updateScene(options: { appState?: Partial<AppState> }): void;
    getSceneElements(): readonly Record<string, unknown>[];
    getAppState(): AppState;
    getFiles(): BinaryFiles;
    getName(): string;
  }
}

declare module "@agent-studio/canvas-editor/element/types" {
  export interface ExcalidrawElement {
    id: string;
    isDeleted?: boolean;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    [key: string]: unknown;
  }
}
