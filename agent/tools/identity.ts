import { createHash } from "node:crypto";
import { canonicalJson } from "../json.js";

export function toolInputHash(toolName: string, toolVersion: string, input: Record<string, unknown>): string {
  return toolInputHashFromJson(toolName, toolVersion, canonicalJson(input));
}

/** Existing ledgers retain the exact canonical JSON text used to generate their hash. */
export function toolInputHashFromJson(toolName: string, toolVersion: string, inputJson: string): string {
  return createHash("sha256").update(`${toolName}\n${toolVersion}\n${inputJson}`, "utf8").digest("hex");
}
