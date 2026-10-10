import type { ModelMessage } from "../model/types.js";
import type { FileArtifact } from "../types.js";
import type { ToolCheckpoint, ToolResult } from "./types.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function artifact(value: unknown): value is FileArtifact {
  return record(value) && typeof value.path === "string"
    && (value.operation === "created" || value.operation === "updated")
    && typeof value.mediaType === "string" && typeof value.byteSize === "number"
    && Number.isSafeInteger(value.byteSize) && value.byteSize >= 0 && typeof value.updatedAt === "string";
}

/** The persisted tool outcome is validated once at its execution/storage boundary. */
export function readToolResult(value: unknown): ToolResult | undefined {
  if (!record(value) || typeof value.ok !== "boolean" || typeof value.output !== "string"
    || typeof value.returncode !== "number" || !Number.isSafeInteger(value.returncode)
    || typeof value.truncated !== "boolean"
    || (value.error !== undefined && typeof value.error !== "string")
    || (value.fullOutputPath !== undefined && typeof value.fullOutputPath !== "string")) return undefined;
  if (value.media !== undefined && (!record(value.media) || typeof value.media.mediaType !== "string" || typeof value.media.dataUrl !== "string")) return undefined;
  if (value.artifacts !== undefined && (!Array.isArray(value.artifacts) || !value.artifacts.every(artifact))) return undefined;
  return value as unknown as ToolResult;
}

export function readToolCheckpoint(value: unknown): ToolCheckpoint | undefined {
  if (!record(value) || typeof value.version !== "number" || !Number.isSafeInteger(value.version)
    || value.version < 1 || typeof value.kind !== "string" || !value.kind || !record(value.data)) return undefined;
  return { version: value.version, kind: value.kind, data: value.data };
}

export function toolOutcomeStatus(result: ToolResult): "succeeded" | "failed" | "cancelled" | "interrupted" {
  return result.error === "cancelled" ? "cancelled" : result.error === "interrupted" ? "interrupted" : result.ok ? "succeeded" : "failed";
}

export function toolResultMessage(call: { id: string; name: string }, result: ToolResult): ModelMessage {
  const note = result.truncated && result.fullOutputPath ? `\nFull output: ${result.fullOutputPath}` : "";
  return {
    role: "tool", content: `<returncode>${result.returncode}</returncode>\n<output>\n${result.output}\n</output>${note}`,
    toolCallId: call.id, toolName: call.name, isError: !result.ok,
    ...(result.media ? { media: result.media } : {}),
  };
}
