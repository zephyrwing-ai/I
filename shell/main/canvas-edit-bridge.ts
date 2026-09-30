import { randomUUID } from "node:crypto";
import type { CanvasEditCancel, CanvasEditRequest, CanvasEditResult } from "../../canvas/commands/types.js";

export interface CanvasEditTransport {
  sendRequest(ownerWebContentsId: number, request: CanvasEditRequest): boolean;
  sendCancel(ownerWebContentsId: number, request: CanvasEditCancel): void;
  onOwnerDestroyed(ownerWebContentsId: number, callback: () => void): () => void;
}

export type CanvasEditRequestBody = Omit<CanvasEditRequest, "requestId" | "deadlineAt">;

export class CanvasEditBridgeError extends Error {
  constructor(readonly code: "canvas_unavailable" | "cancelled" | "outcome_unknown", message: string) {
    super(message);
    this.name = "CanvasEditBridgeError";
  }
}

interface PendingRequest {
  ownerWebContentsId: number;
  request: CanvasEditRequest;
  resolve: (result: CanvasEditResult) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

/** Main owns request identity and accepts results only from the run's window. */
export class CanvasEditBridge {
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly transport: CanvasEditTransport,
    private readonly timeoutMs = 20_000,
  ) {}

  request(
    ownerWebContentsId: number,
    body: CanvasEditRequestBody,
    signal?: AbortSignal,
  ): Promise<CanvasEditResult> {
    if (signal?.aborted) {
      return Promise.reject(new CanvasEditBridgeError("cancelled", "The run stopped before the canvas edit began."));
    }
    const request: CanvasEditRequest = {
      ...body,
      requestId: randomUUID(),
      deadlineAt: Date.now() + this.timeoutMs,
    };
    return new Promise<CanvasEditResult>((resolve, reject) => {
      let sent = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribeDestroyed: () => void = () => undefined;
      const cancel: CanvasEditCancel = {
        requestId: request.requestId,
        runId: request.runId,
        projectId: request.projectId,
      };
      const finish = (result: CanvasEditResult | Error): void => {
        if (settled) return;
        settled = true;
        this.pending.delete(request.requestId);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        unsubscribeDestroyed();
        if (result instanceof Error) {
          if (sent) {
            try {
              this.transport.sendCancel(ownerWebContentsId, cancel);
            } catch {
              // The owner may already be gone; the pending request is settled here.
            }
          }
          reject(result);
        } else {
          resolve(result);
        }
      };
      const onAbort = () => finish(new CanvasEditBridgeError(
        sent ? "outcome_unknown" : "cancelled",
        sent
          ? "The canvas edit was cancelled while applying; its outcome could not be confirmed."
          : "The run stopped before the canvas edit began.",
      ));
      this.pending.set(request.requestId, {
        ownerWebContentsId,
        request,
        resolve: (result) => finish(result),
        reject: (error) => finish(error),
        cleanup: () => finish(new CanvasEditBridgeError("outcome_unknown", "The canvas edit response was not received.")),
      });
      try {
        unsubscribeDestroyed = this.transport.onOwnerDestroyed(ownerWebContentsId, () => {
          finish(new CanvasEditBridgeError(
            sent ? "outcome_unknown" : "canvas_unavailable",
            "The canvas window closed before the edit completed.",
          ));
        });
        if (settled) {
          unsubscribeDestroyed();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
          onAbort();
          return;
        }
        timer = setTimeout(() => finish(new CanvasEditBridgeError(
          "outcome_unknown",
          "The canvas edit did not respond before its deadline; its outcome could not be confirmed.",
        )), this.timeoutMs);
        if (!this.transport.sendRequest(ownerWebContentsId, request)) {
          finish(new CanvasEditBridgeError("canvas_unavailable", "The canvas window is unavailable."));
          return;
        }
        sent = true;
      } catch (error) {
        finish(new CanvasEditBridgeError(
          sent ? "outcome_unknown" : "canvas_unavailable",
          error instanceof Error ? error.message : String(error),
        ));
      }
    });
  }

  handleResult(senderWebContentsId: number, result: unknown): boolean {
    if (!isRecord(result) || typeof result.requestId !== "string") return false;
    const pending = this.pending.get(result.requestId);
    if (!pending || pending.ownerWebContentsId !== senderWebContentsId) return false;
    if (result.runId !== pending.request.runId || result.projectId !== pending.request.projectId) {
      pending.reject(new CanvasEditBridgeError("outcome_unknown", "The canvas edit response belongs to another run or project."));
      return false;
    }
    if (typeof result.ok !== "boolean" ||
        (result.appliedElements !== undefined && !isRecordArray(result.appliedElements)) ||
        (result.conflicts !== undefined && !isRecordArray(result.conflicts)) ||
        (result.createdIds !== undefined && (!Array.isArray(result.createdIds) || !result.createdIds.every((id) => typeof id === "string")))) {
      pending.reject(new CanvasEditBridgeError("outcome_unknown", "The canvas edit response is invalid."));
      return false;
    }
    pending.resolve(result as unknown as CanvasEditResult);
    return true;
  }

  dispose(): void {
    for (const request of [...this.pending.values()]) request.cleanup();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord);
}
