declare module "@agent-studio/canvas-editor" {
  import type React from "react";

  export const Excalidraw: React.ComponentType<Record<string, unknown>>;
  export function exportToBlob(options: Record<string, unknown>): Promise<Blob>;
}

declare module "@agent-studio/canvas-editor/types" {
  export interface AppState {
    selectedElementIds?: Record<string, boolean>;
    theme?: string;
    viewBackgroundColor?: string;
    gridSize?: number | null;
    gridStep?: number;
    zoom?: unknown;
    scrollX?: number;
    scrollY?: number;
    [key: string]: unknown;
  }

  export type BinaryFiles = Record<string, Record<string, unknown>>;

  export interface ExcalidrawImperativeAPI {
    getSceneElements(): readonly Record<string, unknown>[];
    getAppState(): AppState;
    getFiles(): BinaryFiles;
  }
}

declare module "@agent-studio/canvas-editor/element/types" {
  export interface ExcalidrawElement {
    id: string;
    isDeleted?: boolean;
    [key: string]: unknown;
  }
}
