import type { HistoryRepository, HistoryScope } from "../memory/types.js";
import type { ToolDef } from "../model/types.js";
import type { RegisteredTool, ToolResult } from "./types.js";

const DEFAULT_LIMIT = 6_000;
const MAX_LIMIT = 12_000;
const MAX_ENTRY_ID_LENGTH = 256;

export const HISTORY_READ_TOOL: ToolDef = {
  name: "history_read",
  description: "Read an exact completed entry from the current history scope (project or General) by entryId. Returns a source header and a character page of stored message JSON, including content, reasoning and tool-call metadata. Images are returned separately on the first page. This retrieves original stored evidence.",
  parameters: {
    type: "object",
    properties: {
      entryId: { type: "string", description: "Exact persisted history entry ID" },
      offset: { type: "integer", description: "Zero-based Unicode character offset in the message JSON (default 0)" },
      limit: { type: "integer", description: "Maximum Unicode characters to return (default 6000, maximum 12000)" },
    },
    required: ["entryId"],
  },
};

function fail(output: string, error: string): ToolResult {
  return { ok: false, output, returncode: -1, truncated: false, error };
}

function pageOf(body: string, offset: number, limit: number): { text: string; total: number; nextOffset: number | null } {
  const page: string[] = [];
  let total = 0;
  for (const character of body) {
    if (total >= offset && page.length < limit) page.push(character);
    total += 1;
  }
  const next = offset + page.length;
  return { text: page.join(""), total, nextOffset: next < total ? next : null };
}

export function createHistoryReadTool(repository: HistoryRepository, projectId: HistoryScope): RegisteredTool {
  return {
    definition: HISTORY_READ_TOOL,
    recovery: { version: "1", mode: "safe" },
    async execute(input, context): Promise<ToolResult> {
      const cancelled = () => fail("History read cancelled.", "cancelled");
      if (context.signal?.aborted) return cancelled();
      const offset = input.offset === undefined ? 0 : input.offset;
      const limit = input.limit === undefined ? DEFAULT_LIMIT : input.limit;
      if (Object.keys(input).some((key) => !["entryId", "offset", "limit"].includes(key))
        || typeof input.entryId !== "string" || !input.entryId.trim() || input.entryId.length > MAX_ENTRY_ID_LENGTH
        || typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0
        || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        return fail("Provide an entryId of 1–256 characters, a non-negative integer offset and a limit from 1 to 12000.", "invalid_arguments");
      }
      let entry;
      try {
        entry = await repository.getEntry(input.entryId);
      } catch {
        return context.signal?.aborted ? cancelled() : fail("History storage could not be read.", "read_failed");
      }
      if (context.signal?.aborted) return cancelled();
      if (!entry || entry.projectId !== projectId || entry.status !== "completed") return fail("History entry not found.", "not_found");
      const { media, ...message } = entry.payload;
      const body = JSON.stringify({ ...message, ...(media ? { media: { mediaType: media.mediaType } } : {}) }, null, 2);
      const page = pageOf(body, offset, limit);
      if (context.signal?.aborted) return cancelled();
      const header = {
        entryId: entry.id, entryOrder: entry.entryOrder, revision: entry.revision, role: entry.payload.role,
        bodyFormat: "ModelMessage JSON; media.dataUrl is delivered separately on the first page",
        offset, totalCharacters: page.total, nextOffset: page.nextOffset,
      };
      return {
        ok: true, returncode: 0, truncated: page.nextOffset !== null,
        output: `${JSON.stringify(header)}\n${page.text}`,
        ...(media && offset === 0 ? { media: { ...media } } : {}),
      };
    },
  };
}
