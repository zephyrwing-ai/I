import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ModelAttachment, ModelImage } from "../../../agent/model/types.js";
import type { AttachmentReader } from "../../../agent/tools/attachment-read.js";
import type { AttachmentImportResult, AttachmentUpload, InputAttachmentDescriptor } from "../../shared/ipc.js";
import { MAX_INPUT_ATTACHMENT_BYTES, MAX_INPUT_ATTACHMENT_COUNT } from "../../shared/ipc.js";
import type { AttachmentPreparation, AttachmentProcessor } from "./processors.js";

export const MAX_ATTACHMENT_BYTES = MAX_INPUT_ATTACHMENT_BYTES;
export const MAX_ATTACHMENT_COUNT = MAX_INPUT_ATTACHMENT_COUNT;
const POLICY_VERSION = "attachment-v1";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

interface AttachmentManifest {
  version: 1;
  parserIdentity: string;
  descriptor: InputAttachmentDescriptor;
  originalFile: string;
  prepared: AttachmentPreparation;
}

export interface ResolvedAttachment extends InputAttachmentDescriptor {
  path: string;
  input: ModelAttachment;
}

/** Owns immutable originals, derived caches and admission independently of projects. */
export class AttachmentStore {
  private operations: Promise<unknown> = Promise.resolve();
  private readonly controller = new AbortController();

  constructor(private readonly directory: string, private readonly processAttachment: AttachmentProcessor) {}

  async ensureDirectory(): Promise<string> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    return this.directory;
  }

  register(paths: string[]): Promise<AttachmentImportResult> {
    return this.import(paths.map((path) => ({ path })));
  }

  import(uploads: AttachmentUpload[]): Promise<AttachmentImportResult> {
    if (this.controller.signal.aborted) return Promise.reject(new Error("Attachment storage is shutting down."));
    if (!Array.isArray(uploads) || uploads.length > MAX_ATTACHMENT_COUNT) return Promise.reject(new Error(`Add up to ${MAX_ATTACHMENT_COUNT} files at a time.`));
    const operation = this.operations.then(async () => {
      const result: AttachmentImportResult = { attachments: [], errors: [] };
      for (const upload of uploads) {
        try {
          const descriptor = await this.ingest(upload);
          if (!result.attachments.some((item) => item.attachmentId === descriptor.attachmentId)) result.attachments.push(descriptor);
        } catch (error) {
          const name = upload && "path" in upload && typeof upload.path === "string" ? basename(upload.path) : upload && "name" in upload && typeof upload.name === "string" ? upload.name : "File";
          result.errors.push({ name, message: error instanceof Error ? error.message : String(error) });
        }
      }
      return result;
    });
    this.operations = operation.catch(() => undefined);
    return operation;
  }

  async dispose(): Promise<void> {
    this.controller.abort();
    await this.operations;
  }

  async resolve(ids: string[]): Promise<ResolvedAttachment[]> {
    if (ids.length > MAX_ATTACHMENT_COUNT || ids.some((id) => typeof id !== "string")) throw new Error("The attachment list is invalid.");
    let remainingText = 24_000;
    let remainingImages = 6;
    const resolved: ResolvedAttachment[] = [];
    for (const id of new Set(ids)) {
      const manifest = await this.load(id);
      const textLength = Math.min(6_000, remainingText);
      const source = manifest.prepared;
      const characters = Array.from(source.text);
      const excerptCharacters = characters.slice(0, textLength);
      const excerpt = excerptCharacters.join("");
      remainingText -= excerptCharacters.length;
      const imageCount = Math.min(source.images.length, remainingImages, manifest.descriptor.mediaType.startsWith("video/") ? 3 : 2);
      remainingImages -= imageCount;
      const inputImages = manifest.descriptor.mediaType.startsWith("video/") && source.images.length > imageCount && imageCount > 1
        ? Array.from({ length: imageCount }, (_, index) => source.images[Math.round(index * (source.images.length - 1) / (imageCount - 1))])
        : source.images.slice(0, imageCount);
      const text = [excerpt,
        `Prepared text: ${characters.length} characters. Prepared images: ${source.images.map((image, index) => `${index}: ${image.label}`).join("; ") || "none"}.`,
        ...(excerptCharacters.length < characters.length ? [`Text excerpt ends here; use attachment_read offset=${excerptCharacters.length} to continue.`] : []),
        ...(source.truncated ? ["Preparation covers a bounded portion of the source; consult its coverage information."] : []),
        ...(source.images.length > imageCount ? [`This request includes ${imageCount} of the prepared images. Use attachment_read imageIndex for other prepared images.`] : []),
      ].filter(Boolean).join("\n");
      resolved.push({ ...manifest.descriptor, path: this.filePath(id, manifest.originalFile), input: { ...manifest.descriptor, text, imageLabels: inputImages.map((image) => image.label) } });
    }
    return resolved;
  }

  resolveModelImages = async (attachment: ModelAttachment, signal?: AbortSignal): Promise<ModelImage[]> => {
    const manifest = await this.load(attachment.attachmentId);
    if (attachment.imageLabels.length > manifest.prepared.images.length) throw new Error(`The prepared images for ${attachment.name} are unavailable.`);
    const images: ModelImage[] = [];
    for (const label of attachment.imageLabels) {
      signal?.throwIfAborted();
      const item = manifest.prepared.images.find((image) => image.label === label);
      if (!item) throw new Error(`The prepared attachment version changed: ${attachment.name}`);
      images.push(await this.image(attachment.attachmentId, item.fileName, item.mediaType));
    }
    return images;
  };

  read: AttachmentReader = async (request, signal) => {
    signal?.throwIfAborted();
    const manifest = await this.load(request.attachmentId);
    const characters = Array.from(manifest.prepared.text);
    const offset = request.offset ?? 0;
    const limit = request.limit ?? 6_000;
    const nextOffset = offset + limit < characters.length ? offset + limit : null;
    const item = request.imageIndex === undefined ? undefined : manifest.prepared.images[request.imageIndex];
    if (request.imageIndex !== undefined && !item) throw new Error("That prepared image index is unavailable. Read the attachment header for available images.");
    const media = item ? await this.image(request.attachmentId, item.fileName, item.mediaType) : undefined;
    signal?.throwIfAborted();
    const header = {
      attachmentId: request.attachmentId, name: manifest.descriptor.name,
      originalPath: this.filePath(request.attachmentId, manifest.originalFile),
      totalCharacters: characters.length, offset, nextOffset,
      boundedPreparation: manifest.prepared.truncated,
      images: manifest.prepared.images.map((image, index) => ({ imageIndex: index, label: image.label })),
    };
    return { ok: true, returncode: 0, truncated: nextOffset !== null || manifest.prepared.truncated, output: `${JSON.stringify(header)}\n${characters.slice(offset, offset + limit).join("")}`, ...(media ? { media } : {}) };
  };

  async resource(id: string, kind: string): Promise<{ path: string; mediaType: string }> {
    const manifest = await this.load(id);
    if (kind === "preview" && manifest.prepared.previewFile) return { path: this.filePath(id, manifest.prepared.previewFile), mediaType: extname(manifest.prepared.previewFile) === ".png" ? "image/png" : "image/jpeg" };
    if (kind === "original" && /^(image|video)\//.test(manifest.descriptor.mediaType)) return { path: this.filePath(id, manifest.originalFile), mediaType: manifest.descriptor.mediaType };
    throw new Error("Attachment preview is unavailable.");
  }

  async originalPath(id: string): Promise<string> {
    const manifest = await this.load(id);
    return this.filePath(id, manifest.originalFile);
  }

  private async ingest(upload: AttachmentUpload): Promise<InputAttachmentDescriptor> {
    this.controller.signal.throwIfAborted();
    if (!upload || typeof upload !== "object") throw new Error("The file upload is invalid.");
    const source = "path" in upload && typeof upload.path === "string" ? await realpath(upload.path) : undefined;
    const name = source ? basename(source) : "name" in upload && typeof upload.name === "string" ? basename(upload.name).slice(0, 255) : "";
    if (!name) throw new Error("The file name is invalid.");
    const sourceStats = source ? await stat(source) : undefined;
    if (sourceStats && !sourceStats.isFile()) throw new Error("Choose a regular file.");
    const bytes = "bytes" in upload && upload.bytes instanceof Uint8Array ? upload.bytes : undefined;
    const byteSize = sourceStats?.size ?? bytes?.byteLength;
    if (byteSize === undefined || byteSize > MAX_ATTACHMENT_BYTES) throw new Error("Each attachment must be at most 100 MB.");
    const extension = /^\.[a-z0-9]{1,12}$/i.test(extname(name)) ? extname(name).toLowerCase() : ".bin";
    await this.ensureDirectory();
    const stage = join(this.directory, `.incoming-${randomUUID()}`);
    await mkdir(stage, { mode: 0o700 });
    try {
      const originalFile = `original${extension}`;
      const original = join(stage, originalFile);
      const parserIdentity = this.processAttachment.identity ?? "static";
      const hash = createHash("sha256").update(`${POLICY_VERSION}\0${parserIdentity}\0${name}\0`);
      let size = 0;
      if (source) {
        await pipeline(createReadStream(source), new Transform({ transform(chunk: Buffer, _encoding, done) {
          size += chunk.length;
          if (size > MAX_ATTACHMENT_BYTES) return done(new Error("The attachment grew beyond the 100 MB limit."));
          hash.update(chunk);
          done(null, chunk);
        } }), createWriteStream(original, { flags: "wx", mode: 0o600 }), { signal: this.controller.signal });
      } else {
        size = bytes!.byteLength;
        hash.update(bytes!);
        await writeFile(original, bytes!, { mode: 0o600, flag: "wx" });
      }
      const id = hash.digest("hex");
      const existing = await this.load(id).catch(() => undefined);
      if (existing) return existing.descriptor;
      const mediaType = mediaTypeForName(name);
      const prepared = await this.processAttachment({ path: original, name, mediaType, outputDirectory: stage }, this.controller.signal);
      validatePreparation(prepared);
      const descriptor: InputAttachmentDescriptor = {
        attachmentId: id, name, mediaType, byteSize: size,
        ...(prepared.previewFile ? { previewUrl: `attachment://${id}/preview` } : {}),
        ...(/^(image|video)\//.test(mediaType) ? { mediaUrl: `attachment://${id}/original` } : {}),
        ...(prepared.durationSeconds !== undefined ? { durationSeconds: prepared.durationSeconds } : {}),
      };
      const manifest: AttachmentManifest = { version: 1, parserIdentity, descriptor, originalFile, prepared };
      await writeFile(join(stage, "manifest.json"), JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
      await rename(stage, join(this.directory, id));
      return descriptor;
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  private async load(id: string): Promise<AttachmentManifest> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("The attachment identity is invalid.");
    const manifestPath = this.filePath(id, "manifest.json");
    const manifestSize = (await stat(manifestPath)).size;
    if (manifestSize > 12 * 1024 * 1024) throw new Error("Attachment metadata exceeds its limit.");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as AttachmentManifest;
    if (manifest.version !== 1 || typeof manifest.parserIdentity !== "string"
      || manifest.descriptor?.attachmentId !== id || typeof manifest.originalFile !== "string") throw new Error("The attachment metadata is invalid.");
    validatePreparation(manifest.prepared);
    if (!(await stat(this.filePath(id, manifest.originalFile))).isFile()) throw new Error("The stored attachment is unavailable.");
    return manifest;
  }

  private filePath(id: string, name: string): string {
    const root = join(this.directory, id);
    const path = join(root, name);
    const part = relative(root, path);
    if (!part || part.startsWith(`..${sep}`) || part === ".." || part.startsWith(sep)) throw new Error("The attachment resource path is invalid.");
    return path;
  }

  private async image(id: string, name: string, mediaType: string): Promise<ModelImage> {
    const path = this.filePath(id, name);
    if ((await stat(path)).size > MAX_IMAGE_BYTES) throw new Error("The prepared attachment image exceeds its input limit.");
    return { mediaType, dataUrl: `data:${mediaType};base64,${(await readFile(path)).toString("base64")}` };
  }
}

function validatePreparation(value: AttachmentPreparation): void {
  if (!value || typeof value.text !== "string" || value.text.length > 2_000_000 || typeof value.truncated !== "boolean"
    || !Array.isArray(value.images) || value.images.length > 6
    || new Set(value.images.map((image) => image.label)).size !== value.images.length
    || !value.images.every((image) => typeof image.fileName === "string" && typeof image.label === "string" && ["image/jpeg", "image/png"].includes(image.mediaType))) throw new Error("The attachment processor returned invalid content.");
}

function mediaTypeForName(name: string): string {
  const types: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp", ".avif": "image/avif", ".heic": "image/heic",
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska", ".m4v": "video/mp4", ".avi": "video/x-msvideo",
    ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json", ".csv": "text/csv", ".svg": "image/svg+xml",
  };
  return types[extname(name).toLowerCase()] ?? "application/octet-stream";
}
