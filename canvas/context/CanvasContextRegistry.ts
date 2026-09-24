import { randomUUID } from "node:crypto";
import type { CanvasContextDescriptor, CanvasContextInput } from "../../shell/shared/ipc.js";

const CONTEXT_TTL_MS = 10 * 60 * 1000;
const MAX_CONTEXTS = 32;
const MAX_SELECTION_ELEMENTS = 1_000;
const MAX_INPUT_JSON_LENGTH = 20 * 1024 * 1024;
const MAX_MODEL_JSON_LENGTH = 512 * 1024;
const MAX_VISUAL_DATA_URL_LENGTH = 8 * 1024 * 1024;

export interface ResolvedCanvasContext {
  descriptor: CanvasContextDescriptor;
  text: string;
  visual?: Readonly<{ mediaType: "image/png"; dataURL: string }>;
}

interface SerializedCanvasSelection {
  type: "excalidraw";
  version: number;
  source: string;
  elements: Record<string, unknown>[];
  appState: Record<string, unknown>;
  files: Record<string, Record<string, unknown>>;
}

export class CanvasContextRegistry {
  private readonly contexts = new Map<string, { context: ResolvedCanvasContext; expiresAt: number }>();

  async prepare(input: CanvasContextInput): Promise<CanvasContextDescriptor> {
    if (input.scope !== "selection") throw new Error("The canvas context scope is invalid.");
    if (input.projectId !== null && (typeof input.projectId !== "string" || input.projectId.length === 0)) {
      throw new Error("The canvas project is invalid.");
    }

    const selection = parseSelection(input.serializedJSON);
    const selectedIds = validateSelectedIds(input.selectedElementIds);
    if (selection.elements.length !== selectedIds.size) {
      throw new Error("The canvas selection does not match the selected elements.");
    }

    const imageFileIds = new Set<string>();
    let imageCount = 0;
    for (const element of selection.elements) {
      const id = element.id;
      if (typeof id !== "string" || !selectedIds.delete(id) || element.isDeleted === true || element.deleted === true) {
        throw new Error("The canvas selection does not match the selected elements.");
      }
      if (typeof element.type !== "string" || element.type.length === 0) {
        throw new Error("The canvas selection contains an invalid element.");
      }
      if (element.type === "image") {
        imageCount += 1;
        if (typeof element.fileId === "string") imageFileIds.add(element.fileId);
      }
    }

    if (selectedIds.size > 0) throw new Error("The canvas selection does not match the selected elements.");
    const files = stripImageData(selection.files, imageFileIds);
    const visual = validateVisual(input.visual, imageCount);
    const text = JSON.stringify({
      type: selection.type,
      version: selection.version,
      source: selection.source,
      elements: selection.elements,
      appState: selection.appState,
      files,
    }, null, 2);
    if (text.length > MAX_MODEL_JSON_LENGTH) throw new Error("The canvas selection is too large for one model reference.");

    const descriptor: CanvasContextDescriptor = Object.freeze({
      contextId: randomUUID(),
      projectId: input.projectId,
      label: `Canvas selection · ${selection.elements.length} elements`,
      scope: "selection",
      elementCount: selection.elements.length,
      imageCount,
      hasVisual: Boolean(visual),
    });
    const context: ResolvedCanvasContext = Object.freeze({
      descriptor,
      text,
      ...(visual ? { visual } : {}),
    });

    this.prune();
    this.contexts.set(descriptor.contextId, { context, expiresAt: Date.now() + CONTEXT_TTL_MS });
    while (this.contexts.size > MAX_CONTEXTS) {
      const oldest = this.contexts.keys().next().value;
      if (!oldest) break;
      this.contexts.delete(oldest);
    }
    return descriptor;
  }

  peekMany(ids: string[], projectId: string | null): ResolvedCanvasContext[] {
    this.prune();
    return [...new Set(ids)].map((id) => {
      const context = this.contexts.get(id)?.context;
      if (!context) throw new Error("The canvas reference expired. Add it to the message again.");
      if (context.descriptor.projectId !== projectId) {
        throw new Error("The canvas reference belongs to another project. Add it to the message again.");
      }
      return context;
    });
  }

  consumeMany(ids: string[]): void {
    for (const id of ids) this.contexts.delete(id);
  }

  clearAll(): void {
    this.contexts.clear();
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, record] of this.contexts) if (record.expiresAt <= now) this.contexts.delete(id);
  }
}

function parseSelection(serializedJSON: string): SerializedCanvasSelection {
  if (typeof serializedJSON !== "string" || serializedJSON.length > MAX_INPUT_JSON_LENGTH) {
    throw new Error("The canvas selection JSON is invalid or too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedJSON);
  } catch {
    throw new Error("The canvas selection JSON is invalid.");
  }
  if (!isRecord(parsed) || parsed.type !== "excalidraw" || parsed.version !== 2 ||
      typeof parsed.source !== "string" || !Array.isArray(parsed.elements) ||
      parsed.elements.length === 0 || parsed.elements.length > MAX_SELECTION_ELEMENTS ||
      !parsed.elements.every(isRecord) || !isRecord(parsed.appState) || !isRecord(parsed.files)) {
    throw new Error("The canvas selection JSON is invalid.");
  }
  return parsed as unknown as SerializedCanvasSelection;
}

function validateSelectedIds(ids: string[]): Set<string> {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_SELECTION_ELEMENTS ||
      !ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256)) {
    throw new Error("Canvas selection context must include at least one existing element.");
  }
  const unique = new Set(ids);
  if (unique.size !== ids.length) throw new Error("The canvas selection contains duplicate element IDs.");
  return unique;
}

function stripImageData(files: SerializedCanvasSelection["files"], imageFileIds: Set<string>): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = Object.create(null);
  for (const id of imageFileIds) {
    if (!Object.hasOwn(files, id)) throw new Error("The canvas selection is missing an image asset.");
  }
  for (const [id, file] of Object.entries(files)) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !imageFileIds.has(id) || !isRecord(file)) {
      throw new Error("The canvas selection contains an unrelated image asset.");
    }
    const { dataURL: _dataURL, ...metadata } = file;
    result[id] = metadata;
  }
  return result;
}

function validateVisual(visual: CanvasContextInput["visual"], imageCount: number): ResolvedCanvasContext["visual"] {
  if (!visual) return undefined;
  if (imageCount === 0 || visual.mediaType !== "image/png" ||
      typeof visual.dataURL !== "string" || visual.dataURL.length > MAX_VISUAL_DATA_URL_LENGTH ||
      !/^data:image\/png;base64,[a-z0-9+/]+={0,2}$/i.test(visual.dataURL)) {
    throw new Error("The canvas visual snapshot is invalid or too large.");
  }
  return Object.freeze({ mediaType: "image/png", dataURL: visual.dataURL });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
