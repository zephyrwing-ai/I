import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { InputAttachmentDescriptor } from "../shared/ipc.js";

const MAX_ATTACHMENTS = 100;

interface AttachmentRecord {
  descriptor: InputAttachmentDescriptor;
  path: string;
}

export interface ResolvedAttachment extends InputAttachmentDescriptor {
  path: string;
}

export class InputAttachmentRegistry {
  private readonly records = new Map<string, AttachmentRecord>();

  async register(paths: string[]): Promise<InputAttachmentDescriptor[]> {
    const descriptors: InputAttachmentDescriptor[] = [];
    for (const candidate of paths) {
      try {
        const path = await realpath(candidate);
        const fileStats = await stat(path);
        if (!fileStats.isFile()) continue;
        const attachmentId = randomUUID();
        const descriptor: InputAttachmentDescriptor = {
          attachmentId,
          name: basename(path),
          mediaType: mediaTypeForPath(path),
          byteSize: Number(fileStats.size),
        };
        this.records.set(attachmentId, { descriptor, path });
        descriptors.push(descriptor);
        while (this.records.size > MAX_ATTACHMENTS) {
          const oldest = this.records.keys().next().value as string | undefined;
          if (!oldest) break;
          this.records.delete(oldest);
        }
      } catch {
        // A file can disappear between the native picker and registration.
      }
    }
    return descriptors;
  }

  async resolve(attachmentIds: string[]): Promise<ResolvedAttachment[]> {
    const uniqueIds = [...new Set(attachmentIds)];
    const attachments: ResolvedAttachment[] = [];
    for (const attachmentId of uniqueIds) {
      const record = this.records.get(attachmentId);
      if (!record) throw new Error("附件不存在或已经失效，请重新上传。");
      try {
        const path = await realpath(record.path);
        const fileStats = await stat(path);
        if (path !== record.path || !fileStats.isFile()) throw new Error();
        attachments.push({ ...record.descriptor, path });
      } catch {
        throw new Error(`附件“${record.descriptor.name}”不存在或无法访问，请重新上传。`);
      }
    }
    return attachments;
  }
}

export function composeTaskWithAttachments(task: string, attachments: ResolvedAttachment[]): string {
  if (attachments.length === 0) return task;
  const list = attachments.map((attachment) => `- ${attachment.name}: ${JSON.stringify(attachment.path)}`).join("\n");
  return `${task}\n\n用户附加了以下本地文件。仅在与任务相关时使用可用工具读取它们：\n${list}`;
}

function mediaTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".md": return "text/markdown";
    case ".json": return "application/json";
    case ".txt": return "text/plain";
    case ".pdf": return "application/pdf";
    default: return "application/octet-stream";
  }
}
