import { useState } from "react";
import type { InputAttachmentDescriptor, OpenOutputFileResult, OutputFileDescriptor } from "../../../../shell/shared/ipc";
import { useI18n } from "../../shared/i18n";
import { Icon } from "../../shared/ui/Icon";
import { safeAttachmentUrl } from "../../shared/attachmentUrl";
import { formatBytes } from "../../shared/format";
import { useOutputFilePreview } from "../output/useOutputFilePreview";

export interface SidebarAttachment { attachment: InputAttachmentDescriptor; pending: boolean }
export type SidebarResource = { kind: "attachment"; attachment: InputAttachmentDescriptor } | { kind: "output"; file: OutputFileDescriptor };

export function SidebarResources({ attachments, files, onOpen, onOpenCanvas }: {
  attachments: SidebarAttachment[];
  files: OutputFileDescriptor[];
  onOpen: (resource: SidebarResource) => void;
  onOpenCanvas: () => void;
}) {
  const t = useI18n();
  const [openError, setOpenError] = useState<string | null>(null);
  const openInSystem = async (open: () => Promise<OpenOutputFileResult>): Promise<void> => {
    setOpenError(null);
    try {
      const result = await open();
      if (!result.ok) setOpenError(result.error);
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
    }
  };
  const openOriginal = (resource: SidebarResource): Promise<void> => openInSystem(() => resource.kind === "output"
    ? window.agentAPI.openOutputFile(resource.file.runId, resource.file.fileId)
    : window.agentAPI.openAttachment(resource.attachment.attachmentId));
  return <section className="sidebar-resources" aria-label={t("Resources")}>
    <div className="sidebar-resource-entries">
      <button type="button" className="sidebar-resource-pill" onClick={() => void openInSystem(() => window.agentAPI.openAttachmentsDirectory())} title={t("Open resource folder")}>
        <Icon name="folder" width="18" height="18" strokeWidth={2} /><span>{t("View All Outputs")}</span>
      </button>
      <button type="button" className="sidebar-resource-pill sidebar-canvas-entry" onClick={onOpenCanvas}>
        <Icon name="line-squiggle" width="18" height="18" strokeWidth={2} /><span>{t("Open Canvas")}</span>
      </button>
    </div>
    {openError && <p className="sidebar-error" role="alert">{openError}</p>}
    {attachments.map(({ attachment, pending }) => <div className="sidebar-resource-row" key={attachment.attachmentId}>
      <button type="button" className="sidebar-resource-main" onClick={() => onOpen({ kind: "attachment", attachment })}>
        <Icon name={attachment.mediaType.startsWith("image/") ? "image" : attachment.mediaType.startsWith("video/") ? "film" : "book-open"} width="18" height="18" />
        <span><strong title={attachment.name}>{attachment.name}</strong><small>{formatBytes(attachment.byteSize)} · {t(pending ? "Pending attachment" : "Uploaded")}</small></span>
      </button>
      <button type="button" className="sidebar-resource-action" onClick={() => void openOriginal({ kind: "attachment", attachment })} aria-label={t("Open original file")} title={t("Open original file")}><Icon name="external" width="17" height="17" /></button>
    </div>)}
    {files.map((file) => <div className="sidebar-resource-row" key={`${file.runId}:${file.fileId}`}>
      <button type="button" className="sidebar-resource-main" onClick={() => onOpen({ kind: "output", file })}>
        <Icon name={file.mediaType.startsWith("image/") ? "image" : "book-open"} width="18" height="18" />
        <span><strong title={file.displayPath}>{file.name}</strong><small>{t(file.operation === "created" ? "Created" : "Updated")} · {formatBytes(file.byteSize)}</small></span>
      </button>
      <button type="button" className="sidebar-resource-action" onClick={() => void openOriginal({ kind: "output", file })} aria-label={t("Open original file")} title={t("Open original file")}><Icon name="external" width="17" height="17" /></button>
    </div>)}
  </section>;
}

export function SidebarResourcePreview({ resource }: { resource: SidebarResource }) {
  const t = useI18n();
  const output = resource.kind === "output" ? resource.file : undefined;
  const { preview, loading, openError, refresh, open } = useOutputFilePreview(output);
  if (resource.kind === "attachment") {
    const attachment = resource.attachment;
    const image = attachment.mediaType.startsWith("image/");
    const video = attachment.mediaType.startsWith("video/");
    const audio = attachment.mediaType.startsWith("audio/");
    const thumbnail = safeAttachmentUrl(attachment.previewUrl);
    const media = safeAttachmentUrl(attachment.mediaUrl);
    const imageSource = (image ? media : undefined) ?? thumbnail;
    return <section className="sidebar-resource-preview" aria-label={t("File preview")}>
      <div className="sidebar-resource-meta">{attachment.mediaType} · {formatBytes(attachment.byteSize)}</div>
      {video && media ? <video src={media} poster={thumbnail} controls playsInline preload="metadata" />
        : audio && media ? <audio src={media} controls preload="metadata" />
        : imageSource ? <img src={imageSource} alt={attachment.name} />
        : <p className="sidebar-empty">{t("Embedded preview not supported")}</p>}
    </section>;
  }
  return <section className="sidebar-resource-preview" aria-label={t("File preview")}>
    <div className="sidebar-preview-actions"><span>{formatBytes(resource.file.byteSize)}</span><button type="button" onClick={() => void refresh()} aria-label={t("Refresh preview")}><Icon name="refresh" width="16" height="16" /></button><button type="button" onClick={() => void open()} aria-label={t("Open in system")}><Icon name="external" width="16" height="16" /></button></div>
    {loading && <p className="sidebar-empty" role="status">{t("Loading preview…")}</p>}
    {!loading && preview?.ok && preview.kind === "text" && <><pre>{preview.content}</pre>{preview.truncated && <p className="sidebar-empty">{t("File is large. Showing only the first {size}", { size: formatBytes(512 * 1024) })}</p>}</>}
    {!loading && preview?.ok && preview.kind === "image" && <img src={preview.dataUrl} alt={resource.file.name} />}
    {!loading && preview?.ok && preview.kind === "unsupported" && <p className="sidebar-empty">{t("Embedded preview not supported")}</p>}
    {!loading && preview && !preview.ok && <p className="sidebar-error" role="alert">{preview.message}</p>}
    {openError && <p className="sidebar-error" role="alert">{openError}</p>}
  </section>;
}
