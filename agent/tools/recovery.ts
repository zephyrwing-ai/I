import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ToolResult, ToolRecoveryResult, ToolCheckpoint, ToolExecutionContext } from "./types.js";

export interface FileCheckpointData {
  path: string;
  beforeHash: string | null;
  afterHash: string;
  operation: "created" | "updated";
  mediaType: string;
  byteSize: number;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function toolInputHash(toolName: string, toolVersion: string, input: Record<string, unknown>): string {
  return createHash("sha256").update(`${toolName}\n${toolVersion}\n${canonicalJson(input)}`, "utf8").digest("hex");
}

export function resolveToolPath(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

export function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function checkpointForTextFile(
  path: string,
  beforeContent: string | null,
  afterContent: string,
  operation: "created" | "updated",
  mediaType: string,
): ToolCheckpoint {
  const data: FileCheckpointData = {
    path,
    beforeHash: beforeContent === null ? null : hashText(beforeContent),
    afterHash: hashText(afterContent),
    operation,
    mediaType,
    byteSize: Buffer.byteLength(afterContent, "utf8"),
  };
  return { version: 1, kind: "text_file", data: data as unknown as Record<string, unknown> };
}

export async function readTextFileIfPresent(path: string): Promise<{ exists: boolean; content: string }> {
  try {
    const file = await readFile(path);
    return { exists: true, content: file.toString("utf8") };
  } catch {
    return { exists: false, content: "" };
  }
}

export async function reconcileTextFile(
  checkpoint: ToolCheckpoint | undefined,
  context: ToolExecutionContext,
  label: string,
): Promise<ToolRecoveryResult> {
  if (!checkpoint || checkpoint.kind !== "text_file" || checkpoint.version !== 1) {
    return { kind: "interrupted", reason: `${label} recovery checkpoint is unavailable or unsupported.` };
  }
  const data = checkpoint.data as unknown as FileCheckpointData;
  let current: { exists: boolean; content: string };
  try {
    current = await readTextFileIfPresent(data.path);
    if (current.exists) await stat(data.path);
  } catch {
    return { kind: "interrupted", reason: `${label} recovery could not inspect ${data.path}.` };
  }

  const currentHash = current.exists ? hashText(current.content) : null;
  if (currentHash === data.afterHash) {
    const result: ToolResult = {
      ok: true,
      output: `${label} was already applied and its result was recovered: ${data.path}`,
      returncode: 0,
      truncated: false,
      artifacts: [{
        path: data.path,
        operation: data.operation,
        mediaType: data.mediaType,
        byteSize: data.byteSize,
        updatedAt: new Date().toISOString(),
      }],
    };
    return { kind: "succeeded", result };
  }
  if (currentHash === data.beforeHash) return { kind: "retry", reason: `${label} was not published; retrying from the recorded before state.` };
  return { kind: "interrupted", reason: `${label} target differs from both recorded before and after states: ${data.path}` };
}
