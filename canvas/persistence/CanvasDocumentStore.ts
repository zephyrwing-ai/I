import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CanvasBinaryFile, CanvasDocument, CanvasElementRecord } from "../../shell/shared/ipc.js";

const MAX_ELEMENTS = 20_000;
const MAX_FILES = 1_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const UNPROJECTED_SCOPE = "__unprojected__";

interface StoredCanvasFile extends Omit<CanvasBinaryFile, "dataURL"> {
  assetName?: string;
}

interface StoredCanvasDocument {
  revision: number;
  elements: CanvasElementRecord[];
  appState: Record<string, unknown>;
  files: Record<string, StoredCanvasFile>;
}

interface ScopePaths {
  directory: string;
  documentPath: string;
}

/** The project identity belongs to each request, never to mutable store state. */
export class CanvasDocumentStore {
  private readonly pendingSaves = new Map<string, Promise<void>>();

  constructor(private readonly userDataPath: string) {}

  async waitForIdle(): Promise<void> {
    while (this.pendingSaves.size > 0) {
      await Promise.all(this.pendingSaves.values());
    }
  }

  async load(projectId: string | null): Promise<{ document: CanvasDocument; revision: number }> {
    const scope = canvasScopeKey(projectId);
    await this.pendingSaves.get(scope);
    const paths = this.paths(scope);
    const stored = await readStoredDocument(paths.documentPath);
    if (!stored) return { document: emptyCanvasDocument(), revision: 0 };

    const files: Record<string, CanvasBinaryFile> = {};
    for (const [id, file] of Object.entries(stored.files ?? {})) {
      validateFileId(id);
      const asset = await readFile(this.assetPath(paths.directory, id, file));
      const { assetName: _assetName, ...metadata } = file;
      files[id] = { ...metadata, dataURL: toDataURL(file.mimeType, asset) };
    }
    return {
      document: {
        elements: Array.isArray(stored.elements) ? stored.elements : [],
        appState: isObject(stored.appState) ? stored.appState : {},
        files,
      },
      revision: stored.revision,
    };
  }

  save(projectId: string | null, document: CanvasDocument): Promise<number> {
    const scope = canvasScopeKey(projectId);
    validateDocument(document);
    const previous = this.pendingSaves.get(scope) ?? Promise.resolve();
    const result = previous.then(() => this.write(this.paths(scope), document));
    // A failed write does not poison subsequent saves for this project.
    const settled = result.then(() => undefined, () => undefined);
    this.pendingSaves.set(scope, settled);
    void settled.then(() => {
      if (this.pendingSaves.get(scope) === settled) this.pendingSaves.delete(scope);
    });
    return result;
  }

  private async write(paths: ScopePaths, document: CanvasDocument): Promise<number> {
    await mkdir(paths.directory, { recursive: true });
    const previous = await readStoredDocument(paths.documentPath);
    const storedFiles: Record<string, StoredCanvasFile> = {};

    for (const [id, file] of Object.entries(document.files)) {
      const metadata: StoredCanvasFile = {
        id,
        mimeType: file.mimeType,
        created: file.created,
        ...(file.lastRetrieved === undefined ? {} : { lastRetrieved: file.lastRetrieved }),
        ...(file.version === undefined ? {} : { version: file.version }),
      };
      if (file.dataURL) {
        const bytes = decodeDataURL(file.dataURL, file.mimeType);
        const digest = createHash("sha256").update(bytes).digest("hex");
        metadata.assetName = `${id}.${digest}.${fileExtension(file.mimeType)}`;
        const assetPath = join(paths.directory, metadata.assetName);
        try {
          await stat(assetPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await writeAtomic(assetPath, bytes);
        }
      } else {
        const oldFile = previous?.files?.[id];
        if (oldFile?.mimeType === file.mimeType && oldFile.assetName) metadata.assetName = oldFile.assetName;
        await stat(this.assetPath(paths.directory, id, metadata));
      }
      storedFiles[id] = metadata;
    }

    const nextRevision = (previous?.revision ?? 0) + 1;
    const stored: StoredCanvasDocument = {
      revision: nextRevision,
      elements: document.elements,
      appState: document.appState,
      files: storedFiles,
    };
    // Immutable assets are published first; replacing the scene is the commit point.
    await writeAtomic(paths.documentPath, JSON.stringify(stored));
    for (const [id, oldFile] of Object.entries(previous?.files ?? {})) {
      const replacement = storedFiles[id];
      if (replacement?.assetName === oldFile.assetName && replacement?.mimeType === oldFile.mimeType) continue;
      try {
        await rm(this.assetPath(paths.directory, id, oldFile), { force: true });
      } catch {
        // Asset cleanup follows the committed scene and can be retried later.
      }
    }
    return nextRevision;
  }

  private paths(scope: string): ScopePaths {
    const directory = join(this.userDataPath, "canvases", scope);
    return { directory, documentPath: join(directory, "scene.json") };
  }

  private assetPath(directory: string, id: string, file: StoredCanvasFile): string {
    if (file.assetName !== undefined) {
      if (!isAssetName(id, file.assetName)) throw new Error("The canvas image asset path is invalid.");
      return join(directory, file.assetName);
    }
    // Documents written before content-addressed assets used this filename.
    return join(directory, `${id}.${fileExtension(file.mimeType)}`);
  }
}

export function canvasScopeKey(projectId: string | null): string {
  if (projectId === null) return UNPROJECTED_SCOPE;
  if (typeof projectId !== "string" || projectId === UNPROJECTED_SCOPE || !/^[a-zA-Z0-9_-]{1,128}$/.test(projectId)) {
    throw new Error("The canvas project identity is invalid.");
  }
  return projectId;
}

export function emptyCanvasDocument(): CanvasDocument {
  return { elements: [], appState: {}, files: {} };
}

async function readStoredDocument(path: string): Promise<StoredCanvasDocument | null> {
  let serialized: string;
  try {
    serialized = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const stored = JSON.parse(serialized) as StoredCanvasDocument;
  stored.revision = Number.isSafeInteger(stored.revision) && stored.revision >= 0 ? stored.revision : 0;
  return stored;
}

async function writeAtomic(path: string, contents: Buffer | string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { flag: "wx" });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function validateDocument(document: CanvasDocument): void {
  if (!document || !Array.isArray(document.elements) || document.elements.length > MAX_ELEMENTS) {
    throw new Error("The canvas scene is invalid or too large.");
  }
  if (!isObject(document.appState) || !isObject(document.files) || Object.keys(document.files).length > MAX_FILES) {
    throw new Error("The canvas state is invalid.");
  }
  for (const [id, file] of Object.entries(document.files)) {
    validateFileId(id);
    if (!file || typeof file.mimeType !== "string" || !/^image\/[a-z0-9.+-]{1,64}$/i.test(file.mimeType)) {
      throw new Error("The canvas contains an unsupported image asset.");
    }
    if (file.dataURL) decodeDataURL(file.dataURL, file.mimeType);
  }
}

function validateFileId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("The canvas contains an unsupported image asset.");
}

function isAssetName(id: string, name: string): boolean {
  return name.startsWith(`${id}.`) && /^[a-zA-Z0-9_-]+\.[a-f0-9]{64}\.[a-zA-Z0-9]+$/.test(name);
}

function fileExtension(mimeType: string): string {
  return mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
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
