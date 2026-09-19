import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CanvasBinaryFile, CanvasDocument, CanvasElementRecord } from "../shared/ipc.js";

const MAX_ELEMENTS = 20_000;
const MAX_FILES = 1_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

interface StoredCanvasFile extends Omit<CanvasBinaryFile, "dataURL"> {}

interface StoredCanvasDocument {
  revision: number;
  elements: CanvasElementRecord[];
  appState: Record<string, unknown>;
  files: Record<string, StoredCanvasFile>;
}

export class CanvasDocumentStore {
  private readonly directory: string;
  private readonly documentPath: string;
  private revision = 0;

  constructor(userDataPath: string, sessionId: string) {
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    this.directory = join(userDataPath, "canvases", safeSessionId);
    this.documentPath = join(this.directory, "scene.json");
  }

  async load(): Promise<{ document: CanvasDocument; revision: number }> {
    let serialized: string;
    try {
      serialized = await readFile(this.documentPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.revision = 0;
      return { document: emptyCanvasDocument(), revision: 0 };
    }
    const stored = JSON.parse(serialized) as StoredCanvasDocument;
    const files: Record<string, CanvasBinaryFile> = {};
    for (const [id, file] of Object.entries(stored.files ?? {})) {
      const assetPath = this.assetPath(id, file.mimeType);
      const asset = await readFile(assetPath);
      files[id] = { ...file, dataURL: toDataURL(file.mimeType, asset) };
    }
    this.revision = Number.isSafeInteger(stored.revision) && stored.revision >= 0 ? stored.revision : 0;
    return {
      document: {
        elements: Array.isArray(stored.elements) ? stored.elements : [],
        appState: isObject(stored.appState) ? stored.appState : {},
        files,
      },
      revision: this.revision,
    };
  }

  async save(document: CanvasDocument): Promise<number> {
    validateDocument(document);
    await mkdir(this.directory, { recursive: true });

    const storedFiles: Record<string, StoredCanvasFile> = {};
    for (const [id, file] of Object.entries(document.files)) {
      const metadata: StoredCanvasFile = {
        id,
        mimeType: file.mimeType,
        created: file.created,
        ...(file.lastRetrieved === undefined ? {} : { lastRetrieved: file.lastRetrieved }),
        ...(file.version === undefined ? {} : { version: file.version }),
      };
      storedFiles[id] = metadata;
      if (file.dataURL) {
        const bytes = decodeDataURL(file.dataURL, file.mimeType);
        const assetPath = this.assetPath(id, file.mimeType);
        const assetTempPath = `${assetPath}.${process.pid}.tmp`;
        await writeFile(assetTempPath, bytes);
        await rename(assetTempPath, assetPath);
      } else {
        await stat(this.assetPath(id, file.mimeType));
      }
    }

    const nextRevision = this.revision + 1;
    const stored: StoredCanvasDocument = {
      revision: nextRevision,
      elements: document.elements,
      appState: document.appState,
      files: storedFiles,
    };
    const tempPath = `${this.documentPath}.${process.pid}.tmp`;
    await writeFile(tempPath, JSON.stringify(stored), "utf8");
    await rename(tempPath, this.documentPath);
    this.revision = nextRevision;
    return nextRevision;
  }

  private assetPath(id: string, mimeType: string): string {
    const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
    return join(this.directory, `${id}.${extension}`);
  }
}

export function emptyCanvasDocument(): CanvasDocument {
  return { elements: [], appState: {}, files: {} };
}

function validateDocument(document: CanvasDocument): void {
  if (!document || !Array.isArray(document.elements) || document.elements.length > MAX_ELEMENTS) {
    throw new Error("The canvas scene is invalid or too large.");
  }
  if (!isObject(document.appState) || !isObject(document.files) || Object.keys(document.files).length > MAX_FILES) {
    throw new Error("The canvas state is invalid.");
  }
  for (const [id, file] of Object.entries(document.files)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || !file || !file.mimeType.startsWith("image/")) {
      throw new Error("The canvas contains an unsupported image asset.");
    }
    if (file.dataURL) decodeDataURL(file.dataURL, file.mimeType);
  }
}

function decodeDataURL(dataURL: string, mimeType: string): Buffer {
  const match = /^data:([^;,]+);base64,([a-z0-9+/=\r\n]+)$/i.exec(dataURL);
  if (!match || match[1].toLowerCase() !== mimeType.toLowerCase()) throw new Error("The canvas image data is invalid.");
  const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("A canvas image is larger than 4 MB.");
  return bytes;
}

function toDataURL(mimeType: string, bytes: Buffer): string {
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
