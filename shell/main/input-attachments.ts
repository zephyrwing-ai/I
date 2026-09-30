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
      if (!record) throw new Error("The attachment does not exist or is no longer valid. Upload it again.");
      try {
        const path = await realpath(record.path);
        const fileStats = await stat(path);
        if (path !== record.path || !fileStats.isFile()) throw new Error();
        attachments.push({ ...record.descriptor, path });
      } catch {
        throw new Error(`The attachment “${record.descriptor.name}” does not exist or cannot be accessed. Upload it again.`);
      }
    }
    return attachments;
  }
}

export function composeTaskWithAttachments(task: string, attachments: ResolvedAttachment[]): string {
  if (attachments.length === 0) return task;
  const list = attachments.map((attachment) => `- ${attachment.name} (attachmentId: ${attachment.attachmentId}): ${JSON.stringify(attachment.path)}`).join("\n");
  return `${task}\n\nThe user attached the following local files. Use the available tools to read them only when relevant to the task. Image attachments can also be inserted into the current Canvas with canvas_edit by referencing their attachmentId:\n${list}`;
}

function mediaTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".bmp": return "image/bmp";
    case ".ico": return "image/x-icon";
    case ".avif": return "image/avif";
    case ".jfif": return "image/jfif";
    case ".md": return "text/markdown";
    case ".json": return "application/json";
    case ".txt": return "text/plain";
    case ".pdf": return "application/pdf";
    default: return "application/octet-stream";
  }
}
