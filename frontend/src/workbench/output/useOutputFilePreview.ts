import { useEffect, useMemo, useState } from "react";
import type { OutputFileDescriptor } from "../../../../shell/shared/ipc";
import {
  createOutputFilePreviewController,
  sameOutputFileIdentity,
  type OutputFilePreviewState,
} from "./outputFilePreview";

export function useOutputFilePreview(selected: OutputFileDescriptor | undefined) {
  const target = useMemo(() => selected ? {
    runId: selected.runId,
    fileId: selected.fileId,
    updatedAt: selected.updatedAt,
  } : null, [selected?.runId, selected?.fileId, selected?.updatedAt]);
  const [state, setState] = useState<OutputFilePreviewState>({
    target: null, preview: null, loading: false, openError: null,
  });
  const [controller] = useState(() => createOutputFilePreviewController({
    previewOutputFile: (runId, fileId) => window.agentAPI.previewOutputFile(runId, fileId),
    openOutputFile: (runId, fileId) => window.agentAPI.openOutputFile(runId, fileId),
  }, setState));

  useEffect(() => {
    void controller.select(target);
    return controller.invalidate;
  }, [controller, target]);

  // A new title must never render the preceding file's content before its effect runs.
  const current = sameOutputFileIdentity(state.target, target)
    ? state
    : { target, preview: null, loading: target !== null, openError: null };

  return {
    preview: current.preview,
    loading: current.loading,
    openError: current.openError,
    refresh: controller.refresh,
    open: controller.open,
  };
}
