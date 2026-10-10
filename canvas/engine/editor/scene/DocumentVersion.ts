import type { CanvasEditorElement } from "../element/types";
import type { BinaryFiles } from "../types";

type ElementStamp = readonly [string, number, number, string | null, boolean];
type FileStamp = readonly [string, string, string, number, number | null, number | null, string];

/** Tracks persisted content independently from drawing-cache invalidation. */
export class DocumentVersionTracker {
  private elements: readonly ElementStamp[] = [];
  private files: readonly FileStamp[] = [];
  private version = 0;

  observe(elements: readonly CanvasEditorElement[], files: BinaryFiles): number {
    const nextElements: ElementStamp[] = elements.map((element) => [
      element.id,
      element.version,
      element.versionNonce,
      element.index ?? null,
      element.isDeleted,
    ]);
    const nextFiles: FileStamp[] = Object.keys(files).sort().map((id) => {
      const file = files[id];
      return [id, file.id, file.mimeType, file.created, file.lastRetrieved ?? null, file.version ?? null, file.dataURL];
    });
    if (!sameStamps(this.elements, nextElements) || !sameStamps(this.files, nextFiles)) {
      this.elements = nextElements;
      this.files = nextFiles;
      this.version += 1;
    }
    return this.version;
  }
}

function sameStamps(current: readonly (readonly unknown[])[], next: readonly (readonly unknown[])[]): boolean {
  return current.length === next.length && current.every((stamp, index) =>
    stamp.length === next[index].length && stamp.every((value, field) => value === next[index][field]));
}
