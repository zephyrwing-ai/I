import type { AttachmentImportResult, InputAttachmentDescriptor } from "../../../../../shell/shared/ipc";
import { MAX_INPUT_ATTACHMENT_COUNT } from "../../../../../shell/shared/ipc";

export const MAX_ATTACHMENTS = MAX_INPUT_ATTACHMENT_COUNT;
export const ATTACHMENT_LIMIT_MESSAGE = `A maximum of ${MAX_ATTACHMENTS} attachments is allowed.`;

/** Both import paths preserve successful files and report each rejected file. */
export function applyAttachmentResult(
  current: InputAttachmentDescriptor[],
  result: AttachmentImportResult,
): AttachmentImportResult {
  const byId = new Map(current.map((attachment) => [attachment.attachmentId, attachment]));
  const errors = [...result.errors];
  for (const attachment of result.attachments) {
    if (byId.has(attachment.attachmentId) || byId.size < MAX_ATTACHMENTS) {
      byId.set(attachment.attachmentId, attachment);
    } else {
      errors.push({ name: attachment.name, message: ATTACHMENT_LIMIT_MESSAGE });
    }
  }
  return { attachments: [...byId.values()], errors };
}

export function formatDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const remainder = String(total % 60).padStart(2, "0");
  return minutes < 60
    ? `${minutes}:${remainder}`
    : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${remainder}`;
}

export function isFileDrag(data: Pick<DataTransfer, "types" | "items" | "files">): boolean {
  return Array.from(data.types).includes("Files")
    || Array.from(data.items).some((item) => item.kind === "file")
    || data.files.length > 0;
}
