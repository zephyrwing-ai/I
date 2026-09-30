import type {
  CanvasEditImageFile,
  CanvasEditElementRecord,
  CanvasEditOperation,
  CanvasEditRequest,
  CanvasEditResult,
} from "../../canvas/commands/types.js";
import type { ToolDef } from "../model/types.js";
import type { RegisteredTool, ToolResult } from "./types.js";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const MAX_OPERATIONS = 32;
const MAX_POINTS = 2_048;
const MAX_TEXT_LENGTH = 20_000;
const MAX_ABSOLUTE_COORDINATE = 1_000_000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;
const ELEMENT_TYPES = new Set(["rectangle", "ellipse", "diamond", "line", "arrow", "freedraw", "text", "image"]);
const DIRECTIONS = new Set(["front", "back", "forward", "backward"]);
const CREATE_FIELDS = new Set(["type", "x", "y", "width", "height", "angle", "text", "points", "fileId", "attachmentId", "startElementId", "endElementId"]);
const CHANGE_FIELDS = new Set(["x", "y", "width", "height", "angle", "text", "points", "scale", "crop"]);

export const CANVAS_EDIT_TOOL: ToolDef = {
  name: "canvas_edit",
  description: "Create elements from the user's instructions. To update, delete, duplicate, group, lock, or reorder existing elements, use the elements explicitly supplied through Use selection. Operations apply to the live scene; targets must come from that reference or an earlier successful canvas_edit result. A conflict returns the affected current elements. Use one call for related operations.",
  parameters: {
    type: "object",
    properties: {
      operations: {
        type: "array",
        description: "One to 32 ordered Canvas operations. create uses element; update uses id and changes; delete/duplicate/reorder/flip/setLocked use id; group/ungroup use ids.",
        items: {
          type: "object",
          description: "A Canvas operation",
          properties: {
            action: { type: "string", description: "Operation kind", enum: ["create", "update", "delete", "duplicate", "reorder", "flip", "setLocked", "group", "ungroup"] },
            id: { type: "string", description: "Existing element ID from Use selection or a successful prior edit" },
            ids: { type: "array", description: "Existing element IDs for group or ungroup", items: { type: "string", description: "Element ID" } },
            element: {
              type: "object",
              description: "New element in scene coordinates. Shape types: rectangle, ellipse, diamond, line, arrow, freedraw, text, image. An image reuses a referenced fileId or imports a user-uploaded image attachment for this run.",
              properties: {
                type: { type: "string", description: "Element type", enum: [...ELEMENT_TYPES] },
                x: { type: "number", description: "Scene X" },
                y: { type: "number", description: "Scene Y" },
                width: { type: "number", description: "Width" },
                height: { type: "number", description: "Height" },
                angle: { type: "number", description: "Rotation in radians" },
                text: { type: "string", description: "Text element content" },
                points: { type: "array", description: "Local coordinates for a line, arrow, or freehand stroke", items: { type: "array", description: "A two-number point", items: { type: "number", description: "Coordinate" } } },
                fileId: { type: "string", description: "Existing image asset ID from the current Canvas" },
                attachmentId: { type: "string", description: "Image attachment ID uploaded by the user for this Run" },
                startElementId: { type: "string", description: "Use selection element ID to bind the start of a new arrow" },
                endElementId: { type: "string", description: "Use selection element ID to bind the end of a new arrow" },
              },
              required: ["type", "x", "y"],
            },
            changes: {
              type: "object",
              description: "Fields to change on an existing element; untouched fields retain the live scene values",
              properties: {
                x: { type: "number", description: "Scene X" },
                y: { type: "number", description: "Scene Y" },
                width: { type: "number", description: "Width" },
                height: { type: "number", description: "Height" },
                angle: { type: "number", description: "Rotation in radians" },
                text: { type: "string", description: "Text content" },
                points: { type: "array", description: "Local line or stroke coordinates", items: { type: "array", description: "A two-number point", items: { type: "number", description: "Coordinate" } } },
                scale: { type: "array", description: "Image scale factors for flipping", items: { type: "number", description: "Scale factor" } },
                crop: { type: "object", description: "Image crop in natural pixel coordinates", properties: { x: { type: "number", description: "Crop X" }, y: { type: "number", description: "Crop Y" }, width: { type: "number", description: "Crop width" }, height: { type: "number", description: "Crop height" }, naturalWidth: { type: "number", description: "Source width" }, naturalHeight: { type: "number", description: "Source height" } }, required: ["x", "y", "width", "height", "naturalWidth", "naturalHeight"] },
              },
              required: [],
            },
            direction: { type: "string", description: "Reorder direction", enum: [...DIRECTIONS] },
            locked: { type: "boolean", description: "Lock state" },
            offsetX: { type: "number", description: "Duplicate X offset" },
            offsetY: { type: "number", description: "Duplicate Y offset" },
          },
          required: ["action"],
        },
      },
    },
    required: ["operations"],
  },
};

export type CanvasEditExecutor = (
  ownerWebContentsId: number,
  body: Omit<CanvasEditRequest, "requestId" | "deadlineAt">,
  signal?: AbortSignal,
) => Promise<CanvasEditResult>;

export interface CanvasEditToolScope {
  runId: string;
  projectId: string | null;
  ownerWebContentsId: number;
  sourceElements: CanvasEditElementRecord[];
  imageAttachments?: Array<{ attachmentId: string; name: string; mediaType: string; byteSize: number; path: string }>;
  execute: CanvasEditExecutor;
}

/** The authority and frozen baseline come from Main's accepted run, never model arguments. */
export function createCanvasEditTool(scope: CanvasEditToolScope): RegisteredTool {
  const baselines = new Map<string, CanvasEditElementRecord>();
  const authorizedIds = new Set<string>();
  for (const element of scope.sourceElements) {
    if (typeof element.id !== "string" || !element.id) throw new Error("The canvas selection contains an invalid element ID.");
    authorizedIds.add(element.id);
    baselines.set(element.id, structuredClone(element));
  }

  return {
    definition: CANVAS_EDIT_TOOL,
    recovery: { version: "1", mode: "never", resumePlanned: false },
    async execute(input, context): Promise<ToolResult> {
      if (context.signal?.aborted) return failure("The run stopped before the canvas edit began.", "cancelled");
      const operations = parseOperations(input.operations);
      if (operations instanceof Error) return failure(operations.message, "invalid_arguments");
      const availableFileIds = new Set([...baselines.values()].flatMap((element) =>
        typeof element.fileId === "string" ? [element.fileId] : []));
      const imageAttachments = new Map((scope.imageAttachments ?? []).filter((item) => item.mediaType.startsWith("image/")).map((item) => [item.attachmentId, item]));
      const imageFilesByAttachment = new Map<string, CanvasEditImageFile>();
      let totalImageBytes = 0;

      for (const operation of operations) {
      if (operation.action === "create") {
          for (const id of [operation.element.startElementId, operation.element.endElementId]) {
            if (id && !baselines.has(id)) {
              return failure(`Arrow binding target ${id} is not in this run's Canvas selection or an earlier edit result.`, "unauthorized_element");
            }
          }
        }
        if (operation.action === "create" && operation.element.type === "image") {
          if (operation.element.fileId && !availableFileIds.has(operation.element.fileId)) {
            return failure("New Canvas images can only reuse an image included in this run's Canvas selection.", "unauthorized_image");
          }
          if (operation.element.attachmentId) {
            const attachment = imageAttachments.get(operation.element.attachmentId);
            if (!attachment) return failure("The image attachment was not uploaded for this Run.", "unauthorized_image");
            if (attachment.byteSize > MAX_IMAGE_BYTES) return failure("Canvas image attachments must be 4 MB or smaller.", "image_too_large");
            if (imageFilesByAttachment.has(attachment.attachmentId)) continue;
            try {
              const bytes = await readFile(attachment.path);
              if (bytes.byteLength > MAX_IMAGE_BYTES || bytes.byteLength !== attachment.byteSize) {
                return failure("The image attachment changed or exceeds the Canvas size limit.", "image_too_large");
              }
              totalImageBytes += bytes.byteLength;
              if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
                return failure("Canvas image imports in one edit are limited to 8 MB total.", "image_batch_too_large");
              }
              imageFilesByAttachment.set(attachment.attachmentId, {
                attachmentId: attachment.attachmentId,
                fileId: randomUUID(),
                mimeType: attachment.mediaType,
                dataURL: `data:${attachment.mediaType};base64,${bytes.toString("base64")}`,
                created: Date.now(),
              });
            } catch {
              return failure("The image attachment could not be read. Upload it again.", "attachment_unavailable");
            }
          }
          if (!operation.element.fileId && !operation.element.attachmentId) {
            return failure("An image element needs a referenced Canvas file or a user image attachment.", "invalid_image_source");
          }
        }
        const ids = operation.action === "create" ? [] : "id" in operation ? [operation.id] : "ids" in operation ? operation.ids : [];
        for (const id of ids) {
          const baseline = baselines.get(id);
          if (!baseline || baseline.isDeleted === true || baseline.deleted === true) {
            return failure(`Element ${id} is not in this run's Canvas selection or a prior edit result.`, "unauthorized_element");
          }
        }
      }

      let result: CanvasEditResult;
      try {
        result = await scope.execute(scope.ownerWebContentsId, {
          runId: scope.runId,
          projectId: scope.projectId,
          operations,
          sourceElements: [...baselines.values()].map((element) => structuredClone(element)),
          ...(imageFilesByAttachment.size ? { imageFiles: [...imageFilesByAttachment.values()] } : {}),
        }, context.signal);
      } catch (error) {
        const code = isRecord(error) && typeof error.code === "string" ? error.code : "canvas_unavailable";
        return failure(error instanceof Error ? error.message : String(error), code);
      }

      const affected = result.appliedElements ?? [];
      const createdIdSet = new Set(result.createdIds ?? []);
      const visibleAffected = affected.filter((element) =>
        typeof element.id === "string" && (authorizedIds.has(element.id) || createdIdSet.has(element.id)));
      for (const element of affected) {
        if (typeof element.id === "string" && authorizedIds.has(element.id)) {
          baselines.set(element.id, structuredClone(element));
        }
      }
      for (const id of result.createdIds ?? []) {
        authorizedIds.add(id);
        const created = affected.find((element) => element.id === id);
        if (created) baselines.set(id, structuredClone(created));
      }
      for (const conflict of result.conflicts ?? []) {
        if (conflict.current && baselines.has(conflict.id)) baselines.set(conflict.id, structuredClone(conflict.current));
      }

      if (!result.ok) {
        const payload = {
          status: result.conflicts?.length ? "conflict" : "failed",
          error: result.error,
          conflicts: (result.conflicts ?? []).map((conflict) => ({
            id: conflict.id,
            reason: conflict.reason,
            ...(conflict.current ? { current: compactElement(conflict.current) } : {}),
          })),
          ...(visibleAffected.length ? { appliedInMemory: true, totalAffected: visibleAffected.length, elements: visibleAffected.slice(0, 64).map(compactElement) } : {}),
          ...(result.createdIds?.length ? { createdIds: result.createdIds } : {}),
        };
        return failure(JSON.stringify(payload), result.conflicts?.length ? "canvas_conflict" : "canvas_edit_failed");
      }
      const compactElements = visibleAffected.map(compactElement);
      return {
        ok: true,
        output: JSON.stringify({ status: "applied", createdIds: result.createdIds ?? [], totalAffected: compactElements.length, elements: compactElements.slice(0, 64) }),
        returncode: 0,
        truncated: false,
      };
    },
  };
}

function parseOperations(value: unknown): CanvasEditOperation[] | Error {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_OPERATIONS) {
    return new Error(`operations must contain between 1 and ${MAX_OPERATIONS} items.`);
  }
  const operations: CanvasEditOperation[] = [];
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw) || typeof raw.action !== "string") return new Error(`Operation ${index + 1} has no valid action.`);
    const action = raw.action;
    if (action === "create") {
      if (!hasOnlyFields(raw, new Set(["action", "element"])) || !isRecord(raw.element) || !hasOnlyFields(raw.element, CREATE_FIELDS) ||
          !ELEMENT_TYPES.has(raw.element.type as string) || !isCoordinate(raw.element.x) || !isCoordinate(raw.element.y) ||
          !validFields(raw.element, true) ||
          ((raw.element.startElementId !== undefined || raw.element.endElementId !== undefined) && raw.element.type !== "arrow") ||
          (raw.element.startElementId !== undefined && !isId(raw.element.startElementId)) ||
          (raw.element.endElementId !== undefined && !isId(raw.element.endElementId)) ||
          (raw.element.type === "image" && Boolean(raw.element.fileId) === Boolean(raw.element.attachmentId)) ||
          (raw.element.type !== "image" && (raw.element.fileId !== undefined || raw.element.attachmentId !== undefined))) {
        return new Error(`Operation ${index + 1} has an invalid element.`);
      }
    } else if (action === "update") {
      if (!hasOnlyFields(raw, new Set(["action", "id", "changes"])) || !isId(raw.id) || !isRecord(raw.changes) || Object.keys(raw.changes).length === 0 ||
          !hasOnlyFields(raw.changes, CHANGE_FIELDS) || !validFields(raw.changes, false)) {
        return new Error(`Operation ${index + 1} has an invalid update.`);
      }
    } else if (action === "delete") {
      if (!hasOnlyFields(raw, new Set(["action", "id"])) || !isId(raw.id)) return new Error(`Operation ${index + 1} has an invalid element ID.`);
    } else if (action === "duplicate") {
      if (!hasOnlyFields(raw, new Set(["action", "id", "offsetX", "offsetY"])) || !isId(raw.id) || (raw.offsetX !== undefined && !isCoordinate(raw.offsetX)) ||
          (raw.offsetY !== undefined && !isCoordinate(raw.offsetY))) return new Error(`Operation ${index + 1} has an invalid duplicate.`);
    } else if (action === "reorder") {
      if (!hasOnlyFields(raw, new Set(["action", "id", "direction"])) || !isId(raw.id) || !DIRECTIONS.has(raw.direction as string)) return new Error(`Operation ${index + 1} has an invalid reorder.`);
    } else if (action === "flip") {
      if (!hasOnlyFields(raw, new Set(["action", "id", "axis"])) || !isId(raw.id) || !["horizontal", "vertical"].includes(raw.axis as string)) return new Error(`Operation ${index + 1} has an invalid flip.`);
    } else if (action === "setLocked") {
      if (!hasOnlyFields(raw, new Set(["action", "id", "locked"])) || !isId(raw.id) || typeof raw.locked !== "boolean") return new Error(`Operation ${index + 1} has an invalid lock state.`);
    } else if (action === "group" || action === "ungroup") {
      if (!hasOnlyFields(raw, new Set(["action", "ids"])) || !Array.isArray(raw.ids) || raw.ids.length < (action === "group" ? 2 : 1) || raw.ids.length > MAX_OPERATIONS ||
          !raw.ids.every(isId) || new Set(raw.ids).size !== raw.ids.length) {
        return new Error(`Operation ${index + 1} has invalid group IDs.`);
      }
    } else {
      return new Error(`Operation ${index + 1} has an unknown action.`);
    }
    operations.push(raw as CanvasEditOperation);
  }
  return operations;
}

function validFields(fields: Record<string, unknown>, isCreate: boolean): boolean {
  for (const [key, value] of Object.entries(fields)) {
    if (["x", "y", "width", "height", "angle"].includes(key)) {
      if (!isCoordinate(value) || ((key === "width" || key === "height") && (value as number) < 0)) return false;
    } else if (key === "text") {
      if (typeof value !== "string" || value.length > MAX_TEXT_LENGTH) return false;
    } else if (key === "points") {
      if (!Array.isArray(value) || value.length === 0 || value.length > MAX_POINTS ||
          !value.every((point) => Array.isArray(point) && point.length === 2 && point.every(isCoordinate))) return false;
    } else if (key === "fileId") {
      if (!isCreate || !isId(value)) return false;
    } else if (key === "attachmentId") {
      if (!isCreate || !isId(value)) return false;
    } else if (key === "scale") {
      if (!Array.isArray(value) || value.length !== 2 || !value.every((scale) => typeof scale === "number" && Number.isFinite(scale) && Math.abs(scale) <= 1 && scale !== 0)) return false;
    } else if (key === "crop") {
      if (!isRecord(value) || !hasOnlyFields(value, new Set(["x", "y", "width", "height", "naturalWidth", "naturalHeight"])) ||
          !["x", "y", "width", "height", "naturalWidth", "naturalHeight"].every((field) => isCoordinate(value[field]))) return false;
    }
  }
  return true;
}

function hasOnlyFields(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_ABSOLUTE_COORDINATE;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function failure(output: string, error: string): ToolResult {
  return { ok: false, output, returncode: -1, truncated: false, error };
}

function compactElement(element: CanvasEditElementRecord): Record<string, unknown> {
  return {
    id: element.id,
    type: element.type,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    angle: element.angle,
    version: element.version,
    versionNonce: element.versionNonce,
    isDeleted: element.isDeleted,
    ...(typeof element.text === "string" ? { text: element.text.slice(0, 2_000) } : {}),
    ...(Array.isArray(element.points) ? { points: element.points.slice(0, 128) } : {}),
    ...(Array.isArray(element.scale) ? { scale: element.scale } : {}),
    ...(element.crop && typeof element.crop === "object" ? { crop: element.crop } : {}),
  };
}
