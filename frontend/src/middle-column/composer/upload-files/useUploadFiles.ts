import { useCallback, useEffect, useRef, useState, type DragEventHandler } from "react";
import type { AttachmentImportResult, InputAttachmentDescriptor } from "../../../../../shell/shared/ipc";
import { applyAttachmentResult, ATTACHMENT_LIMIT_MESSAGE, isFileDrag, MAX_ATTACHMENTS } from "./attachments";

interface UploadScope {
  key: string | null;
}

interface UploadDraft {
  scope: UploadScope;
  attachments: InputAttachmentDescriptor[];
  errors: AttachmentImportResult["errors"];
  busy: boolean;
  dragging: boolean;
}

function emptyDraft(scope: UploadScope): UploadDraft {
  return { scope, attachments: [], errors: [], busy: false, dragging: false };
}

export function useUploadFiles({ scopeKey, disabled }: { scopeKey: string | null; disabled: boolean }) {
  // Identity also separates A -> B -> A from the original A's pending import.
  const identity = useRef<UploadScope>({ key: scopeKey });
  if (identity.current.key !== scopeKey) identity.current = { key: scopeKey };
  const scope = identity.current;
  const [storedDraft, setDraft] = useState(() => emptyDraft(scope));
  const draft = storedDraft.scope === scope ? storedDraft : emptyDraft(scope);
  const mounted = useRef(true);
  const pending = useRef<{ scope: UploadScope } | null>(null);
  const enterDepth = useRef(0);
  const context = useRef({ scope, disabled, draft });
  context.current = { scope, disabled, draft };

  // Scope identity controls visibility immediately; the effect discards the old backing state.
  useEffect(() => {
    if (context.current.scope === scope) setDraft((current) => current.scope === scope ? current : emptyDraft(scope));
  }, [scope]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current = null; };
  }, []);

  const resetDrag = useCallback(() => {
    enterDepth.current = 0;
    setDraft((current) => current.scope === scope && current.dragging ? { ...current, dragging: false } : current);
  }, [scope]);

  useEffect(resetDrag, [resetDrag, disabled, draft.busy]);

  const importResult = useCallback(async (load: () => Promise<AttachmentImportResult>): Promise<void> => {
    const current = context.current;
    if (!mounted.current || current.scope !== scope || current.disabled || pending.current?.scope === scope) return;
    if (current.draft.attachments.length >= MAX_ATTACHMENTS) {
      setDraft((value) => value.scope === scope ? { ...value, errors: [{ name: "", message: ATTACHMENT_LIMIT_MESSAGE }] } : value);
      return;
    }

    const request = { scope };
    pending.current = request;
    resetDrag();
    setDraft((value) => value.scope === scope ? { ...value, busy: true, errors: [] } : value);
    const isCurrent = () => mounted.current && context.current.scope === scope && pending.current === request;
    try {
      const result = await load();
      if (!isCurrent()) return;
      setDraft((value) => value.scope === scope ? { ...value, ...applyAttachmentResult(value.attachments, result), busy: false } : value);
    } catch (error) {
      if (!isCurrent()) return;
      setDraft((value) => value.scope === scope ? {
        ...value,
        busy: false,
        errors: [{ name: "", message: error instanceof Error ? error.message : "Attachment import failed. Retry." }],
      } : value);
    } finally {
      if (pending.current === request) pending.current = null;
    }
  }, [resetDrag, scope]);

  const pickFiles = useCallback(() => importResult(() => {
    if (typeof window === "undefined" || !window.agentAPI?.selectAttachments) throw new Error("File uploads are unavailable.");
    return window.agentAPI.selectAttachments();
  }), [importResult]);

  const importFiles = useCallback((files: File[]) => {
    if (files.length === 0) return Promise.resolve();
    return importResult(() => {
      if (typeof window === "undefined" || !window.agentAPI?.importAttachments) throw new Error("File uploads are unavailable.");
      return window.agentAPI.importAttachments(files);
    });
  }, [importResult]);

  const removeAttachments = useCallback((ids: string[]) => {
    const removed = new Set(ids);
    setDraft((current) => current.scope === scope ? {
      ...current, attachments: current.attachments.filter((attachment) => !removed.has(attachment.attachmentId)),
    } : current);
  }, [scope]);

  const blocked = disabled || draft.busy;
  const onDragEnter: DragEventHandler<HTMLDivElement> = (event) => {
    if (!isFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (blocked) return;
    enterDepth.current += 1;
    setDraft((current) => current.scope === scope && !current.dragging ? { ...current, dragging: true } : current);
  };
  const onDragOver: DragEventHandler<HTMLDivElement> = (event) => {
    if (!isFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = blocked ? "none" : "copy";
  };
  const onDragLeave: DragEventHandler<HTMLDivElement> = (event) => {
    if (!isFileDrag(event.dataTransfer) && enterDepth.current === 0) return;
    event.preventDefault();
    event.stopPropagation();
    enterDepth.current = Math.max(0, enterDepth.current - 1);
    if (enterDepth.current === 0) resetDrag();
  };
  const onDrop: DragEventHandler<HTMLDivElement> = (event) => {
    if (!isFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    resetDrag();
    if (!blocked) void importFiles(Array.from(event.dataTransfer.files));
  };

  return {
    attachments: draft.attachments,
    errors: draft.errors,
    busy: draft.busy,
    dragging: !blocked && draft.dragging,
    disabled: blocked,
    pickFiles,
    importFiles,
    removeAttachment: (id: string) => { if (!blocked) removeAttachments([id]); },
    removeAttachments,
    hasPendingUpload: () => pending.current?.scope === scope,
    dismissErrors: () => setDraft((current) => current.scope === scope ? { ...current, errors: [] } : current),
    dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  };
}
