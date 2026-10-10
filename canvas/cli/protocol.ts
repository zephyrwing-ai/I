import type { CanvasEditOperation, CanvasEditResult } from "../commands/types.js";

export const MAX_CLI_BYTES = 16 * 1024 * 1024;

export interface CanvasCliRequest {
  kind: "canvas:apply";
  operations: CanvasEditOperation[];
}

export type CanvasCliReply =
  | { kind: "canvas:result"; result: CanvasEditResult }
  | { kind: "canvas:error"; code: string; message: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isCliRequest(value: unknown): value is CanvasCliRequest {
  return isRecord(value) && value.kind === "canvas:apply" && Array.isArray(value.operations);
}

export function isCliReply(value: unknown): value is CanvasCliReply {
  if (!isRecord(value)) return false;
  if (value.kind === "canvas:error") return typeof value.code === "string" && typeof value.message === "string";
  if (value.kind !== "canvas:result" || !isRecord(value.result)) return false;
  const result = value.result;
  return typeof result.requestId === "string" && typeof result.runId === "string" &&
    (result.projectId === null || typeof result.projectId === "string") && typeof result.ok === "boolean" &&
    (result.changed === undefined || typeof result.changed === "boolean") &&
    (result.error === undefined || typeof result.error === "string") &&
    (result.appliedElements === undefined || (Array.isArray(result.appliedElements) && result.appliedElements.every(isRecord))) &&
    (result.conflicts === undefined || (Array.isArray(result.conflicts) && result.conflicts.every((conflict) =>
      isRecord(conflict) && typeof conflict.id === "string" && typeof conflict.reason === "string" &&
      (conflict.current === undefined || isRecord(conflict.current))))) &&
    (result.createdIds === undefined || (Array.isArray(result.createdIds) && result.createdIds.every((id) => typeof id === "string")));
}
