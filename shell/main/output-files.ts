import { randomUUID } from "node:crypto";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import type { FileArtifact } from "../../agent/types.js";
import type {
  OutputFileDescriptor,
  OutputFilePreviewResult,
} from "../shared/ipc.js";

const MAX_TEXT_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

interface OutputFileRecord {
  descriptor: OutputFileDescriptor;
  path: string;
}

export class OutputFileRegistry {
  private readonly runs = new Map<string, Map<string, OutputFileRecord>>();

  register(runId: string, cwd: string, artifacts: FileArtifact[]): OutputFileDescriptor[] {
    let files = this.runs.get(runId);
    if (!files) {
      files = new Map();
      this.runs.set(runId, files);
      while (this.runs.size > 12) this.runs.delete(this.runs.keys().next().value as string);
    }

    const byPath = new Map([...files.values()].map((record) => [record.path, record]));
    const descriptors: OutputFileDescriptor[] = [];
    for (const artifact of artifacts) {
      const normalizedPath = resolve(artifact.path);
      const existing = byPath.get(normalizedPath);
      if (artifact.operation === "updated" && !existing) continue;
      const fileId = existing?.descriptor.fileId ?? randomUUID();
      const descriptor: OutputFileDescriptor = {
        runId,
        fileId,
        name: basename(normalizedPath),
        displayPath: displayPath(cwd, normalizedPath),
        operation: existing ? "updated" : "created",
        mediaType: artifact.mediaType,
        byteSize: artifact.byteSize,
        updatedAt: artifact.updatedAt,
      };
      const record = { descriptor, path: normalizedPath };
      files.set(fileId, record);
      byPath.set(normalizedPath, record);
      descriptors.push(descriptor);
    }
    return descriptors;
  }

  async preview(runId: string, fileId: string): Promise<OutputFilePreviewResult> {
    const record = this.get(runId, fileId);
    if (!record) return failure("not_found", "输出文件不存在或已经失效。");
    const verified = await verifyRecord(record);
    if (!verified.ok) return failure("not_found", verified.message);

    const fileStats = verified.stats;
    const updatedAt = fileStats.mtime.toISOString();
    const byteSize = Number(fileStats.size);
    if (IMAGE_MEDIA_TYPES.has(record.descriptor.mediaType)) {
      if (byteSize > MAX_IMAGE_BYTES) return failure("too_large", "图片超过 5 MB，无法内嵌预览。", record.descriptor.mediaType, byteSize);
      try {
        const content = await readFile(record.path);
        return {
          ok: true,
          kind: "image",
          mediaType: record.descriptor.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
          dataUrl: `data:${record.descriptor.mediaType};base64,${content.toString("base64")}`,
          byteSize,
          updatedAt,
        };
      } catch {
        return failure("read_failed", "图片读取失败。", record.descriptor.mediaType, byteSize);
      }
    }

    if (!isTextMediaType(record.descriptor.mediaType)) {
      return {
        ok: true,
        kind: "unsupported",
        mediaType: record.descriptor.mediaType,
        byteSize,
        updatedAt,
      };
    }

    try {
      const size = Math.min(byteSize, MAX_TEXT_BYTES);
      const handle = await open(record.path, "r");
      try {
        const buffer = Buffer.alloc(size);
        const { bytesRead } = await handle.read(buffer, 0, size, 0);
        return {
          ok: true,
          kind: "text",
          mediaType: record.descriptor.mediaType,
          content: buffer.subarray(0, bytesRead).toString("utf8"),
          truncated: byteSize > MAX_TEXT_BYTES,
          byteSize,
          updatedAt,
        };
      } finally {
        await handle.close();
      }
    } catch {
      return failure("read_failed", "文件读取失败。", record.descriptor.mediaType, byteSize);
    }
  }

  resolveForOpen(runId: string, fileId: string): OutputFileRecord | undefined {
    return this.get(runId, fileId);
  }

  private get(runId: string, fileId: string): OutputFileRecord | undefined {
    return this.runs.get(runId)?.get(fileId);
  }
}

export async function validateOutputForOpen(record: { path: string }): Promise<
  { ok: true; path: string } | { ok: false; error: string }
> {
  try {
    const canonical = await realpath(record.path);
    if (canonical !== record.path) return { ok: false, error: "输出文件路径已经变化。" };
    const fileStats = await stat(canonical);
    if (!fileStats.isFile()) return { ok: false, error: "输出目标不再是文件。" };
    return { ok: true, path: canonical };
  } catch {
    return { ok: false, error: "输出文件不存在或无法访问。" };
  }
}

function displayPath(cwd: string, path: string): string {
  const relativePath = relative(resolve(cwd), path);
  if (relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`)) return relativePath;
  return path;
}

async function verifyRecord(record: OutputFileRecord): Promise<{ ok: true; stats: Awaited<ReturnType<typeof stat>> } | { ok: false; message: string }> {
  try {
    const canonical = await realpath(record.path);
    if (canonical !== record.path) return { ok: false, message: "输出文件路径已经变化。" };
    const stats = await stat(canonical);
    if (!stats.isFile()) return { ok: false, message: "输出目标不再是文件。" };
    return { ok: true, stats };
  } catch {
    return { ok: false, message: "输出文件不存在或无法访问。" };
  }
}

function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith("text/")
    || mediaType === "application/json"
    || mediaType === "application/xml"
    || mediaType === "application/yaml";
}

function failure(
  error: "invalid_request" | "not_found" | "unsupported" | "too_large" | "read_failed",
  message: string,
  mediaType?: string,
  byteSize?: number,
): OutputFilePreviewResult {
  return { ok: false, error, message, mediaType, byteSize };
}
