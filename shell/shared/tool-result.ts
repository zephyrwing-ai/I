import type { ToolResult } from "./ipc.js";

/** Public fields shared by live events and persisted-history delivery. */
export function toPublicToolResult(result: ToolResult): ToolResult {
  return {
    ok: result.ok,
    output: result.output,
    returncode: result.returncode,
    truncated: result.truncated,
    error: result.error,
  };
}

/** Decode the stored outcome at the Main boundary before exposing public fields. */
export function readPublicToolResult(value: unknown): ToolResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result = value as Record<string, unknown>;
  if (typeof result.ok !== "boolean" || typeof result.output !== "string"
    || typeof result.returncode !== "number" || !Number.isSafeInteger(result.returncode)
    || typeof result.truncated !== "boolean"
    || (result.error !== undefined && typeof result.error !== "string")) return undefined;
  return toPublicToolResult({
    ok: result.ok,
    output: result.output,
    returncode: result.returncode,
    truncated: result.truncated,
    error: result.error,
  });
}
