import type {
  CanvasDocument,
  CanvasDocumentResult,
  CanvasPersistenceVersion,
  CanvasSaveRequest,
  CanvasSaveResult,
} from "../../shell/shared/ipc.js";

export interface CanvasSaveState {
  readonly phase: "clean" | "scheduled" | "saving" | "error" | "conflict";
  readonly dirty: boolean;
  readonly error: string | null;
}

interface CanvasSaveCoordinatorOptions {
  projectId: string | null;
  initial: CanvasDocumentResult;
  save: (request: CanvasSaveRequest) => Promise<CanvasSaveResult>;
  onStateChange?: (state: CanvasSaveState) => void;
  debounceMs?: number;
}

interface FlushWaiter {
  generation: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class CanvasSaveConflictError extends Error {
  readonly version: CanvasPersistenceVersion;

  constructor(version: CanvasPersistenceVersion) {
    super("The canvas changed on disk. Your local draft is preserved.");
    this.name = "CanvasSaveConflictError";
    this.version = { ...version };
  }
}

/** Owns one project's draft, save acknowledgements and serial persistence queue.
 * Call flush() before dispose() to commit the retiring editor's latest draft.
 * dispose() allows the active request to settle and stops subsequent requests.
 */
export class CanvasSaveCoordinator {
  private readonly projectId: string | null;
  private readonly saveDocument: CanvasSaveCoordinatorOptions["save"];
  private readonly onStateChange: CanvasSaveCoordinatorOptions["onStateChange"];
  private readonly debounceMs: number;
  private latestDocument: CanvasDocument;
  private version: CanvasPersistenceVersion;
  private generation = 0;
  private savedGeneration = 0;
  private inFlightGeneration: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private conflict: CanvasSaveConflictError | null = null;
  private waiters: FlushWaiter[] = [];
  private currentState: CanvasSaveState = Object.freeze({ phase: "clean", dirty: false, error: null });

  constructor(options: CanvasSaveCoordinatorOptions) {
    this.projectId = options.projectId;
    this.saveDocument = options.save;
    this.onStateChange = options.onStateChange;
    this.debounceMs = options.debounceMs ?? 450;
    this.latestDocument = options.initial.document;
    this.version = { ...options.initial.version };
  }

  get document(): CanvasDocument {
    return this.latestDocument;
  }

  get state(): CanvasSaveState {
    return this.currentState;
  }

  update(document: CanvasDocument): void {
    if (this.disposed) return;
    // Editor updates retain one latest reference; cloning happens at submission.
    this.latestDocument = document;
    this.generation += 1;
    if (this.conflict || this.currentState.phase === "error") {
      this.publish(this.currentState.phase, this.currentState.error);
      return;
    }
    if (this.inFlightGeneration !== null) {
      this.publish("saving");
      return;
    }
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.startSave();
    }, this.debounceMs);
    this.publish("scheduled");
  }

  /** Resolves when this call's generation (or a newer snapshot) is committed. */
  flush(): Promise<void> {
    if (this.conflict) return Promise.reject(this.conflict);
    if (this.savedGeneration >= this.generation) return Promise.resolve();
    if (this.disposed) return Promise.reject(disposedError());
    this.clearTimer();
    const result = new Promise<void>((resolve, reject) => {
      this.waiters.push({ generation: this.generation, resolve, reject });
    });
    this.startSave();
    return result;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    // Waiters covered by the active snapshot still receive its acknowledgement.
    const activeGeneration = this.inFlightGeneration ?? this.savedGeneration;
    this.waiters = this.waiters.filter((waiter) => {
      if (waiter.generation <= activeGeneration) return true;
      waiter.reject(disposedError());
      return false;
    });
  }

  private startSave(): void {
    if (this.disposed || this.conflict || this.inFlightGeneration !== null || this.savedGeneration >= this.generation) return;
    const generation = this.generation;
    let request: CanvasSaveRequest;
    try {
      request = {
        projectId: this.projectId,
        document: structuredClone(this.latestDocument),
        expectedVersion: { ...this.version },
      };
    } catch (error) {
      this.fail(error);
      return;
    }
    this.inFlightGeneration = generation;
    this.publish("saving");
    void this.persist(request, generation);
  }

  private async persist(request: CanvasSaveRequest, generation: number): Promise<void> {
    try {
      const result = await this.saveDocument(request);
      this.inFlightGeneration = null;
      if (result.status === "conflict") {
        this.conflict = new CanvasSaveConflictError(result.version);
        this.rejectWaiters(this.conflict);
        this.publish("conflict", this.conflict.message);
        return;
      }
      this.version = { ...result.version };
      this.savedGeneration = generation;
      this.waiters = this.waiters.filter((waiter) => {
        if (waiter.generation > this.savedGeneration) return true;
        waiter.resolve();
        return false;
      });
      if (this.savedGeneration < this.generation && !this.disposed) {
        this.startSave();
      } else {
        this.publish(this.savedGeneration < this.generation ? "scheduled" : "clean");
      }
    } catch (error) {
      this.inFlightGeneration = null;
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.clearTimer();
    this.rejectWaiters(failure);
    this.publish("error", failure.message);
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters = [];
  }

  private publish(phase: CanvasSaveState["phase"], error: string | null = null): void {
    const dirty = this.savedGeneration < this.generation;
    if (this.currentState.phase === phase && this.currentState.dirty === dirty && this.currentState.error === error) return;
    this.currentState = Object.freeze({ phase, dirty, error });
    if (!this.disposed) this.onStateChange?.(this.currentState);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

function disposedError(): Error {
  return new Error("The canvas save coordinator has been disposed.");
}
