import { randomUUID } from "node:crypto";
import type { CanvasContextDescriptor, CanvasContextInput, CanvasDocument } from "../shared/ipc.js";
import { CanvasDocumentStore } from "./canvas-document.js";

const CONTEXT_TTL_MS = 10 * 60 * 1000;
const MAX_CONTEXT_TEXT = 12_000;
const MAX_CONTEXTS = 32;

export interface ResolvedCanvasContext {
  descriptor: CanvasContextDescriptor;
  text: string;
  visual?: { mediaType: "image/png"; dataURL: string };
}

export class CanvasContextRegistry {
  private readonly contexts = new Map<string, { context: ResolvedCanvasContext; expiresAt: number }>();

  constructor(private readonly documentStore: CanvasDocumentStore) {}

  async load(): Promise<{ document: CanvasDocument; revision: number }> {
    return this.documentStore.load();
  }

  async save(document: CanvasDocument): Promise<number> {
    return this.documentStore.save(document);
  }

  async prepare(input: CanvasContextInput): Promise<CanvasContextDescriptor> {
    if (input.scope !== "selection" && input.scope !== "document") throw new Error("The canvas context scope is invalid.");
    if (input.visual && (!input.visual.dataURL.startsWith("data:image/png;base64,") || input.visual.dataURL.length > 8 * 1024 * 1024)) {
      throw new Error("The canvas visual snapshot is invalid or too large.");
    }
    const revision = await this.documentStore.save(input.document);
    const allElements = input.document.elements.filter((element) => element.deleted !== true && element.isDeleted !== true);
    const selectedIds = new Set(input.selectedElementIds);
    const elements = input.scope === "selection"
      ? allElements.filter((element) => typeof element.id === "string" && selectedIds.has(element.id))
      : allElements;
    const imageCount = elements.filter((element) => element.type === "image" || typeof element.fileId === "string").length;
    const descriptor: CanvasContextDescriptor = {
      contextId: randomUUID(),
      label: input.scope === "selection" ? `Canvas selection · ${elements.length} elements` : `Canvas · ${elements.length} elements`,
      scope: input.scope,
      elementCount: elements.length,
      imageCount,
      revision,
      hasVisual: Boolean(input.visual),
    };
    const text = summarizeCanvas(elements, revision, input.scope);
    this.contexts.set(descriptor.contextId, {
      context: { descriptor, text, ...(input.visual ? { visual: input.visual } : {}) },
      expiresAt: Date.now() + CONTEXT_TTL_MS,
    });
    this.prune();
    while (this.contexts.size > MAX_CONTEXTS) {
      const oldest = this.contexts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.contexts.delete(oldest);
    }
    return descriptor;
  }

  takeMany(ids: string[]): ResolvedCanvasContext[] {
    this.prune();
    const unique = [...new Set(ids)];
    const records = unique.map((id) => {
      const record = this.contexts.get(id);
      if (!record) throw new Error("The canvas reference expired. Add it to the message again.");
      return { id, record };
    });
    const contexts: ResolvedCanvasContext[] = [];
    for (const { id, record } of records) {
      contexts.push(record.context);
      this.contexts.delete(id);
    }
    return contexts;
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, record] of this.contexts) if (record.expiresAt <= now) this.contexts.delete(id);
  }
}

function summarizeCanvas(elements: Record<string, unknown>[], revision: number, scope: string): string {
  const lines = [`Canvas context (revision ${revision}, ${scope}).`, "Use this as visual working context for this run only:"];
  const sorted = [...elements].sort((a, b) => numberValue(a.y) - numberValue(b.y) || numberValue(a.x) - numberValue(b.x));
  for (const element of sorted) {
    const type = typeof element.type === "string" ? element.type : "element";
    const id = typeof element.id === "string" ? element.id : "unknown";
    const text = typeof element.text === "string" ? ` text=${JSON.stringify(element.text.slice(0, 1000))}` : "";
    const label = typeof element.label === "string" ? ` label=${JSON.stringify(element.label.slice(0, 300))}` : "";
    const relation = element.startBinding || element.endBinding ? ` bindings=${JSON.stringify({ start: element.startBinding, end: element.endBinding })}` : "";
    lines.push(`- ${type}#${id}${text}${label}${relation}`);
    if (lines.join("\n").length >= MAX_CONTEXT_TEXT) break;
  }
  return lines.join("\n").slice(0, MAX_CONTEXT_TEXT);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
