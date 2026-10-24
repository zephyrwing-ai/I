export type ApplicationPhase = "running" | "draining" | "terminating";

interface ShutdownOperations {
  prepare: () => Promise<void>;
  drain: () => Promise<void>;
  close: () => void;
  exit: (code: number) => void;
  onError: (error: unknown) => void;
}

/** Shared services stay usable until admitted work and renderer drafts are settled. */
export class ApplicationLifecycle {
  private currentPhase: ApplicationPhase = "running";
  private readonly requests = new Set<Promise<unknown>>();
  private shutdown: Promise<void> | null = null;

  constructor(private readonly operations: ShutdownOperations) {}

  get phase(): ApplicationPhase { return this.currentPhase; }

  admit<T>(operation: () => T | Promise<T>, allowDuringDrain = false): Promise<T> {
    if (this.currentPhase !== "running" && !(this.currentPhase === "draining" && allowDuringDrain)) {
      return Promise.reject(new Error("The application is preparing to quit. Try again if the window remains open."));
    }
    const result = Promise.resolve().then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.requests.add(settled);
    void settled.then(() => this.requests.delete(settled));
    return result;
  }

  async waitForRequests(): Promise<void> {
    while (this.requests.size > 0) await Promise.all(this.requests);
  }

  requestQuit(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.currentPhase = "draining";
    const operation = this.finishQuit();
    this.shutdown = operation;
    return operation;
  }

  private async finishQuit(): Promise<void> {
    try {
      await Promise.resolve().then(() => this.operations.prepare());
    } catch (error) {
      // Preparation keeps services alive so a failed Canvas save can be retried.
      this.currentPhase = "running";
      this.shutdown = null;
      this.operations.onError(error);
      return;
    }
    let exitCode = 0;
    try {
      await this.waitForRequests();
      await this.operations.drain();
    } catch (error) {
      exitCode = 1;
      this.operations.onError(error);
    } finally {
      this.currentPhase = "terminating";
      try {
        this.operations.close();
      } catch (error) {
        exitCode = 1;
        this.operations.onError(error);
      } finally {
        // app.exit cannot be cancelled after shared services have closed.
        this.operations.exit(exitCode);
      }
    }
  }
}

interface WindowResourceOwner {
  readonly webContents: {
    readonly id: number;
    once(event: "destroyed", callback: () => void): unknown;
  };
}

interface WindowResources {
  voicePermissionOwners: Set<number>;
  quitPreparation: { removeOwner(ownerId: number): void };
  voiceTranscription: { cancelOwner(ownerId: number): void };
}

/** Capture the live owner's identity once; teardown uses only that stable ID. */
export function registerWindowResources(window: WindowResourceOwner, resources: WindowResources): void {
  const owner = window.webContents;
  const ownerId = owner.id;
  resources.voicePermissionOwners.add(ownerId);
  owner.once("destroyed", () => {
    resources.voicePermissionOwners.delete(ownerId);
    resources.quitPreparation.removeOwner(ownerId);
    resources.voiceTranscription.cancelOwner(ownerId);
  });
}

interface ApplicationEvents {
  on(event: "before-quit", callback: (event: { preventDefault(): void }) => void): unknown;
  on(event: "activate" | "window-all-closed", callback: () => void): unknown;
}

interface SignalEvents {
  on(event: "SIGTERM" | "SIGINT", callback: () => void): unknown;
}

export function installApplicationLifecycle(
  application: ApplicationEvents,
  signals: SignalEvents,
  lifecycle: ApplicationLifecycle,
  windows: { hasOpenWindows: () => boolean; create: () => void; platform: string },
): void {
  application.on("before-quit", (event) => {
    event.preventDefault();
    void lifecycle.requestQuit();
  });
  application.on("activate", () => {
    if (lifecycle.phase === "running" && !windows.hasOpenWindows()) windows.create();
  });
  application.on("window-all-closed", () => {
    if (windows.platform !== "darwin") void lifecycle.requestQuit();
  });
  signals.on("SIGTERM", () => { void lifecycle.requestQuit(); });
  signals.on("SIGINT", () => { void lifecycle.requestQuit(); });
}
