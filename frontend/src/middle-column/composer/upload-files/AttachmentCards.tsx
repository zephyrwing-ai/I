import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { InputAttachmentDescriptor } from "../../../../../shell/shared/ipc";
import { useI18n } from "../../../shared/i18n";
import { Icon } from "../../../shared/ui/Icon";
import { safeAttachmentUrl } from "../../../shared/attachmentUrl";
import { formatBytes } from "../../../shared/format";
import { formatDuration } from "./attachments";
import "./upload-files.css";

interface AttachmentCardsProps {
  attachments: InputAttachmentDescriptor[];
  onRemove?: (attachmentId: string) => void;
  disabled?: boolean;
}

/** The same cards serve the editable draft and read-only history. */
export function AttachmentCards({ attachments, onRemove, disabled = false }: AttachmentCardsProps) {
  const t = useI18n();
  const [previewId, setPreviewId] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const preview = attachments.find((attachment) => attachment.attachmentId === previewId);
  useEffect(() => {
    if (previewId && !preview) setPreviewId(null);
  }, [previewId, preview]);
  if (attachments.length === 0) return null;

  return (
    <>
      <div className="upload-files-cards" aria-label={t("Attachments")}>
        {attachments.map((attachment) => {
          const image = attachment.mediaType.startsWith("image/");
          const video = attachment.mediaType.startsWith("video/");
          const media = image || video;
          const thumbnail = safeAttachmentUrl(attachment.previewUrl) ?? (image ? safeAttachmentUrl(attachment.mediaUrl) : undefined);
          const source = safeAttachmentUrl(attachment.mediaUrl) ?? (image ? thumbnail : undefined);
          const duration = video ? formatDuration(attachment.durationSeconds) : undefined;
          const visual = (
            <>
              {thumbnail ? <img src={thumbnail} alt="" loading="lazy" decoding="async" /> : <Icon name="image" width={24} height={24} />}
              {video && <span className="upload-files-play" aria-hidden="true">▶</span>}
              {duration && <span className="upload-files-duration">{duration}</span>}
            </>
          );
          return (
            <div className={`upload-files-card ${media ? "is-media" : "is-file"}`} key={attachment.attachmentId}>
              {media ? source ? (
                <button className="upload-files-preview" type="button" disabled={disabled} aria-label={t("Preview {name}", { name: attachment.name })} aria-haspopup="dialog" onClick={(event) => {
                  opener.current = event.currentTarget;
                  setPreviewId(attachment.attachmentId);
                }}>{visual}</button>
              ) : <div className="upload-files-preview">{visual}</div>
                : <span className="upload-files-icon"><Icon name="book-open" width={15} height={15} /></span>}
              {media && onRemove && <button className="upload-files-remove is-overlay" type="button" disabled={disabled} onClick={() => onRemove(attachment.attachmentId)} aria-label={t("Remove attachment {name}", { name: attachment.name })} title={t("Remove attachment")}><Icon name="close" width={14} height={14} /></button>}
              <div className="upload-files-footer">
                {media && <Icon className="upload-files-kind" name={video ? "film" : "image"} width={15} height={15} />}
                <span className="upload-files-info"><strong title={attachment.name}>{attachment.name}</strong><small>{formatBytes(attachment.byteSize)}</small></span>
                {!media && onRemove && <button className="upload-files-remove" type="button" disabled={disabled} onClick={() => onRemove(attachment.attachmentId)} aria-label={t("Remove attachment {name}", { name: attachment.name })} title={t("Remove attachment")}><Icon name="close" width={14} height={14} /></button>}
              </div>
            </div>
          );
        })}
      </div>
      {preview && typeof document !== "undefined" && createPortal(
        <AttachmentPreview key={preview.attachmentId} attachment={preview} opener={opener.current} onClose={() => setPreviewId(null)} />,
        document.body,
      )}
    </>
  );
}

function AttachmentPreview({ attachment, opener, onClose }: {
  attachment: InputAttachmentDescriptor;
  opener: HTMLButtonElement | null;
  onClose: () => void;
}) {
  const t = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const video = attachment.mediaType.startsWith("video/");
  const thumbnail = safeAttachmentUrl(attachment.previewUrl);
  const source = safeAttachmentUrl(attachment.mediaUrl) ?? (!video ? thumbnail : undefined);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => {
      element.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);

  return (
    <dialog ref={dialog} className="upload-files-dialog" aria-label={t("Preview {name}", { name: attachment.name })} onClose={onClose} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="upload-files-dialog-content">
        <div className="upload-files-dialog-header">
          <strong title={attachment.name}>{attachment.name}</strong>
          <button type="button" autoFocus onClick={onClose} aria-label={t("Close preview")}><Icon name="close" width={18} height={18} /></button>
        </div>
        {video ? <video src={source} poster={thumbnail} controls playsInline preload="metadata" aria-label={attachment.name} onError={() => setPlaybackFailed(true)} /> : <img src={source} alt={attachment.name} />}
        {playbackFailed && <p className="upload-files-playback-error" role="status">{t("This video format cannot be played here. Its preview frames remain available.")}</p>}
      </div>
    </dialog>
  );
}
