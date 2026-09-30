/** JSON-only commands crossing the Main/Renderer boundary. */
export type CanvasEditElementRecord = Record<string, unknown>;

export type CanvasEditElementType =
  | "rectangle"
  | "ellipse"
  | "diamond"
  | "line"
  | "arrow"
  | "freedraw"
  | "text"
  | "image";

export interface CanvasEditCreateElement {
  type: CanvasEditElementType;
  x: number;
  y: number;
  width?: number;
  height?: number;
  angle?: number;
  text?: string;
  /** Points use the editor's local element coordinates. */
  points?: [number, number][];
  /** References a file already present in the current Canvas scene. */
  fileId?: string;
  /** Imports a user-attached image into the current Canvas document. */
  attachmentId?: string;
  /** Bind an arrow endpoint to an explicitly referenced element. */
  startElementId?: string;
  endElementId?: string;
}

export interface CanvasEditChanges {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  angle?: number;
  text?: string;
  points?: [number, number][];
  scale?: [number, number];
  crop?: { x: number; y: number; width: number; height: number; naturalWidth: number; naturalHeight: number };
}

export type CanvasEditOperation =
  | { action: "create"; element: CanvasEditCreateElement }
  | { action: "update"; id: string; changes: CanvasEditChanges }
  | { action: "delete"; id: string }
  | { action: "duplicate"; id: string; offsetX?: number; offsetY?: number }
  | { action: "reorder"; id: string; direction: "front" | "back" | "forward" | "backward" }
  | { action: "flip"; id: string; axis: "horizontal" | "vertical" }
  | { action: "setLocked"; id: string; locked: boolean }
  | { action: "group"; ids: string[] }
  | { action: "ungroup"; ids: string[] };

export interface CanvasEditRequest {
  requestId: string;
  runId: string;
  projectId: string | null;
  deadlineAt: number;
  /** Frozen Use selection elements, supplied by Main, never by the model. */
  sourceElements: CanvasEditElementRecord[];
  operations: CanvasEditOperation[];
  imageFiles?: CanvasEditImageFile[];
}

export interface CanvasEditImageFile {
  attachmentId: string;
  fileId: string;
  mimeType: string;
  dataURL: string;
  created: number;
}

export interface CanvasEditCancel {
  requestId: string;
  runId: string;
  projectId: string | null;
}

export interface CanvasEditConflict {
  id: string;
  reason: string;
  current?: CanvasEditElementRecord;
}

export interface CanvasEditOutcome {
  ok: boolean;
  /** False means the request was valid but did not change the scene. */
  changed?: boolean;
  /** Full affected elements, including new versions and tombstones. */
  appliedElements?: CanvasEditElementRecord[];
  createdIds?: string[];
  conflicts?: CanvasEditConflict[];
  error?: string;
}

export interface CanvasEditResult extends CanvasEditOutcome {
  requestId: string;
  runId: string;
  projectId: string | null;
}
