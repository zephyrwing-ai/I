import type {
  AgentAPI,
  OutputFileDescriptor,
  OutputFilePreviewResult,
} from "../../../shell/shared/ipc";

export type OutputFileIdentity = Pick<OutputFileDescriptor, "runId" | "fileId" | "updatedAt">;

export interface OutputFilePreviewState {
  target: OutputFileIdentity | null;
  preview: OutputFilePreviewResult | null;
  loading: boolean;
  openError: string | null;
}

export function sameOutputFileIdentity(
  left: OutputFileIdentity | null,
  right: OutputFileIdentity | null,
): boolean {
  return left === right || (left !== null && right !== null
    && left.runId === right.runId
    && left.fileId === right.fileId
    && left.updatedAt === right.updatedAt);
}

export function createOutputFilePreviewController(
  api: Pick<AgentAPI, "previewOutputFile" | "openOutputFile">,
  publish: (state: OutputFilePreviewState) => void,
) {
  let target: OutputFileIdentity | null = null;
  let previewGeneration = 0;
  let openGeneration = 0;
  let state: OutputFilePreviewState = { target: null, preview: null, loading: false, openError: null };

  const update = (patch: Partial<OutputFilePreviewState>): void => {
    state = { ...state, ...patch };
    publish(state);
  };

  const invalidate = (): void => {
    target = null;
    previewGeneration += 1;
    openGeneration += 1;
  };

  const refresh = async (): Promise<void> => {
    if (!target) return;
    const requestedTarget = target;
    const generation = ++previewGeneration;
    // Refresh clears file actions too, so a preceding open failure cannot reappear.
    openGeneration += 1;
    update({ target: requestedTarget, preview: null, loading: true, openError: null });
    let preview: OutputFilePreviewResult;
    try {
      preview = await api.previewOutputFile(requestedTarget.runId, requestedTarget.fileId);
    } catch (error) {
      preview = {
        ok: false,
        error: "read_failed",
        message: errorMessage(error, "Failed to read the file preview."),
      };
    }
    if (generation !== previewGeneration || !sameOutputFileIdentity(target, requestedTarget)) return;
    update({ preview, loading: false });
  };

  const select = (nextTarget: OutputFileIdentity | null): Promise<void> => {
    invalidate();
    target = nextTarget ? { ...nextTarget } : null;
    if (target) return refresh();
    update({ target: null, preview: null, loading: false, openError: null });
    return Promise.resolve();
  };

  const open = async (): Promise<void> => {
    if (!target) return;
    const requestedTarget = target;
    const generation = ++openGeneration;
    update({ openError: null });
    let openError: string | null;
    try {
      const result = await api.openOutputFile(requestedTarget.runId, requestedTarget.fileId);
      openError = result.ok ? null : result.error;
    } catch (error) {
      openError = errorMessage(error, "Failed to open the file.");
    }
    if (generation !== openGeneration || !sameOutputFileIdentity(target, requestedTarget)) return;
    update({ openError });
  };

  return { select, refresh, open, invalidate };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
