import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CanvasBinaryFile,
  CanvasDocument,
  CanvasDocumentResult,
  CanvasElementRecord,
  CanvasPersistenceVersion,
  CanvasSaveResult,
} from "../../shell/shared/ipc.js";

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

  async load(projectId: string | null): Promise<CanvasDocumentResult> {
    const scope = canvasScopeKey(projectId);
    await this.pendingSaves.get(scope);
    const paths = this.paths(scope);
    const stored = await readStoredDocument(paths.documentPath);
    if (!stored) return { document: emptyCanvasDocument(), version: persistenceVersion(null) };

    const files: Record<string, CanvasBinaryFile> = Object.create(null);
    for (const [id, file] of Object.entries(stored.files)) {
      const asset = await readFile(this.assetPath(paths.directory, id, file));
      const { assetName: _assetName, ...metadata } = file;
      files[id] = { ...metadata, dataURL: toDataURL(file.mimeType, asset) };
    }
    return {
      document: {
        elements: stored.elements,
        appState: stored.appState,
        files,
      },
      version: persistenceVersion(stored),
    };
  }

  save(projectId: string | null, document: CanvasDocument, expectedVersion: CanvasPersistenceVersion): Promise<CanvasSaveResult> {
    const scope = canvasScopeKey(projectId);
    const snapshot = structuredClone(document);
    const baseline = { ...expectedVersion };
    validateDocument(snapshot);
    validateVersion(baseline);
    const previous = this.pendingSaves.get(scope) ?? Promise.resolve();
    const result = previous.then(() => this.write(this.paths(scope), snapshot, baseline));
    // A failed write does not poison subsequent saves for this project.
    const settled = result.then(() => undefined, () => undefined);
    this.pendingSaves.set(scope, settled);
    void settled.then(() => {
      if (this.pendingSaves.get(scope) === settled) this.pendingSaves.delete(scope);
    });
    return result;
  }

  private async write(
    paths: ScopePaths,
    document: CanvasDocument,
    expectedVersion: CanvasPersistenceVersion,
  ): Promise<CanvasSaveResult> {
    const previous = await readStoredDocument(paths.documentPath);
    const previousVersion = persistenceVersion(previous);
    const storedFiles: Record<string, StoredCanvasFile> = Object.create(null);
    const assets = new Map<string, Buffer | null>();

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
        assets.set(join(paths.directory, metadata.assetName), bytes);
      } else {
        const oldFile = previous?.files?.[id];
        if (oldFile?.mimeType === file.mimeType && oldFile.assetName) metadata.assetName = oldFile.assetName;
        assets.set(this.assetPath(paths.directory, id, metadata), null);
      }
      storedFiles[id] = metadata;
    }

    const stored: StoredCanvasDocument = {
      revision: previousVersion.revision + 1,
      elements: document.elements,
      appState: document.appState,
      files: storedFiles,
    };
    const nextVersion = persistenceVersion(stored);
    // Identical scene content can acknowledge a lost reply after its assets are verified.
    const sameContent = nextVersion.fingerprint === previousVersion.fingerprint;
    if (!sameContent && !sameVersion(expectedVersion, previousVersion)) return { status: "conflict", version: previousVersion };
    if (!sameContent && !Number.isSafeInteger(stored.revision)) throw new Error("The canvas revision limit has been reached.");

    if (assets.size > 0 || !sameContent) await mkdir(paths.directory, { recursive: true });
    for (const [assetPath, bytes] of assets) {
      try {
        const asset = await stat(assetPath);
        if (!asset.isFile()) throw new Error("The canvas image asset is invalid.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || bytes === null) throw error;
        await writeAtomic(assetPath, bytes);
      }
    }
    // Asset preparation yields to other writers; verify the scene again at the commit boundary.
    const currentVersion = persistenceVersion(await readStoredDocument(paths.documentPath));
    if (nextVersion.fingerprint === currentVersion.fingerprint) return { status: "saved", version: currentVersion };
    if (!sameVersion(previousVersion, currentVersion)) return { status: "conflict", version: currentVersion };

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
    return { status: "saved", version: nextVersion };
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
  const parsed: unknown = JSON.parse(serialized);
  if (!isObject(parsed)) throw new Error("The stored canvas document is invalid.");
  const stored: StoredCanvasDocument = {
    revision: parsed.revision === undefined ? 0 : parsed.revision,
    elements: parsed.elements === undefined ? [] : parsed.elements,
    appState: parsed.appState === undefined ? {} : parsed.appState,
    files: parsed.files === undefined ? {} : parsed.files,
  };
  if (!Number.isSafeInteger(stored.revision) || stored.revision < 0) {
    throw new Error("The stored canvas revision is invalid.");
  }
  validateDocument(stored);
  for (const [id, file] of Object.entries(stored.files)) {
    if (file.assetName !== undefined && (typeof file.assetName !== "string" || !isAssetName(id, file.assetName))) {
      throw new Error("The canvas image asset path is invalid.");
    }
  }
  return stored;
}

function persistenceVersion(document: StoredCanvasDocument | null): CanvasPersistenceVersion {
  const { elements, appState, files } = document ?? emptyCanvasDocument();
  return {
    revision: document?.revision ?? 0,
    fingerprint: createHash("sha256").update(canonicalJSON({ elements, appState, files })).digest("hex"),
  };
}

/** JSON normalization preserves array order while treating object key order as formatting. */
function canonicalJSON(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!isObject(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
  });
}

function sameVersion(a: CanvasPersistenceVersion, b: CanvasPersistenceVersion): boolean {
  return a.revision === b.revision && a.fingerprint === b.fingerprint;
}

function validateVersion(version: CanvasPersistenceVersion): void {
  if (!Number.isSafeInteger(version.revision) || version.revision < 0 || !/^[a-f0-9]{64}$/.test(version.fingerprint)) {
    throw new Error("The canvas persistence version is invalid.");
  }
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
  if (document.elements.some((element) => !isObject(element))) throw new Error("The canvas scene contains an invalid element.");
  if (!isObject(document.appState) || !isObject(document.files) || Object.keys(document.files).length > MAX_FILES) {
    throw new Error("The canvas state is invalid.");
  }
  for (const [id, file] of Object.entries(document.files)) {
    validateFileId(id);
    if (!isObject(file) || typeof file.mimeType !== "string" || !/^image\/[a-z0-9.+-]{1,64}$/i.test(file.mimeType)) {
      throw new Error("The canvas contains an unsupported image asset.");
    }
    if (file.id !== id || !Number.isFinite(file.created) ||
      (file.lastRetrieved !== undefined && !Number.isFinite(file.lastRetrieved)) ||
      (file.version !== undefined && !Number.isFinite(file.version)) ||
      (file.dataURL !== undefined && typeof file.dataURL !== "string")) {
      throw new Error("The canvas image metadata is invalid.");
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
