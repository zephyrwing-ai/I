import { randomUUID } from "node:crypto";
import type { QuitPreparationResult } from "../shared/ipc.js";

interface WaitingRenderer {
  requestId: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** Each mounted renderer acknowledges its own Canvas flush before service teardown. */
export class QuitPreparation {
  private readonly ready = new Set<number>();
  private readonly waiting = new Map<number, WaitingRenderer>();

  constructor(private readonly timeoutMs = 15_000) {}

  setReady(ownerId: number, ready: boolean): void {
    if (ready) this.ready.add(ownerId);
    else this.ready.delete(ownerId);
  }

  removeOwner(ownerId: number): void {
    this.ready.delete(ownerId);
    this.waiting.get(ownerId)?.resolve();
  }

  isWaiting(ownerId: number): boolean { return this.waiting.has(ownerId); }

  complete(ownerId: number, result: QuitPreparationResult): void {
    const pending = this.waiting.get(ownerId);
    if (!pending || !result || result.requestId !== pending.requestId) return;
    if (result.error !== undefined) pending.reject(new Error(`Canvas could not be saved: ${String(result.error)}`));
    else pending.resolve();
  }

  async flush(owners: Array<{ id: number; send: (requestId: string) => void }>): Promise<void> {
    const tasks = owners.filter((owner) => this.ready.has(owner.id)).map((owner) => new Promise<void>((resolve, reject) => {
      const requestId = randomUUID();
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        this.waiting.delete(owner.id);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => finish(new Error("Canvas did not acknowledge its saved changes. Try quitting again.")), this.timeoutMs);
      this.waiting.set(owner.id, { requestId, resolve: () => finish(), reject: finish });
      try { owner.send(requestId); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    }));
    const results = await Promise.allSettled(tasks);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  }
}
