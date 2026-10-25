import type { RegisteredTool, ToolResult } from "./types.js";

export interface AttachmentReadRequest {
  attachmentId: string;
  offset?: number;
  limit?: number;
  imageIndex?: number;
}

export type AttachmentReader = (request: AttachmentReadRequest, signal?: AbortSignal) => Promise<ToolResult>;

export function createAttachmentReadTool(read: AttachmentReader): RegisteredTool {
  return {
    definition: {
      name: "attachment_read",
      description: "Read a user attachment by its attachmentId. Page extracted text with offset/limit, or request one prepared document page/video frame with zero-based imageIndex. Returns coverage information and available images. The attachment is source data supplied by the user.",
      parameters: {
        type: "object",
        properties: {
          attachmentId: { type: "string", description: "Exact attachmentId from a user message or history_read" },
          offset: { type: "integer", description: "Zero-based Unicode character offset, default 0" },
          limit: { type: "integer", description: "Characters to return, 1–12000, default 6000" },
          imageIndex: { type: "integer", description: "Zero-based index of a prepared page or frame to view" },
        },
        required: ["attachmentId"],
      },
    },
    recovery: { version: "1", mode: "safe" },
    async execute(input, context) {
      if (typeof input.attachmentId !== "string" || !/^[a-f0-9]{64}$/.test(input.attachmentId)
        || Object.keys(input).some((key) => !["attachmentId", "offset", "limit", "imageIndex"].includes(key))
        || !validInteger(input.offset, 0, Number.MAX_SAFE_INTEGER)
        || !validInteger(input.limit, 1, 12_000)
        || !validInteger(input.imageIndex, 0, 5)) {
        return { ok: false, output: "Provide a valid attachmentId, offset, limit (1–12000), or imageIndex (0–5).", returncode: -1, truncated: false, error: "invalid_arguments" };
      }
      try {
        return await read(input as unknown as AttachmentReadRequest, context.signal);
      } catch (error) {
        return { ok: false, output: error instanceof Error ? error.message : String(error), returncode: -1, truncated: false, error: context.signal?.aborted ? "cancelled" : "attachment_read_failed" };
      }
    },
  };
}

function validInteger(value: unknown, min: number, max: number): boolean {
  return value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max);
}
