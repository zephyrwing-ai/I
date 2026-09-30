import type { AgentSteeringInbox, RunStatus, SteeringInput } from "../../agent/loop.js";
import type { HistoryRecorder, HistoryScope, PendingRunInput } from "../../agent/memory/types.js";

const MAX_PENDING_INPUTS = 32;
const MAX_INPUT_CHARS = 20_000;

/** Main owns admission while Runtime owns the point at which accepted text enters the model. */
export class RunInputInbox implements AgentSteeringInbox {
  private accepting = true;
  private readonly inFlight = new Set<Promise<PendingRunInput>>();
  private readonly requests = new Map<string, { content: string; result: Promise<PendingRunInput> }>();
  private readonly queuedIds = new Set<string>();
  private queued: PendingRunInput[] = [];
  private closing: Promise<string[]> | null = null;

  constructor(
    readonly runId: string,
    readonly projectId: HistoryScope,
    private readonly recorder: HistoryRecorder,
  ) {}

  async accept(inputId: string, content: string): Promise<PendingRunInput> {
    const normalized = content.trim();
    if (!normalized || normalized.length > MAX_INPUT_CHARS) {
      throw new Error(`Steering text must contain between 1 and ${MAX_INPUT_CHARS} characters.`);
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(inputId)) throw new Error("The steering input ID is invalid.");
    const previous = this.requests.get(inputId);
    if (previous) {
      if (previous.content !== normalized) throw new Error("The steering input ID belongs to different text.");
      return previous.result;
    }
    if (!this.accepting) throw new Error("The current run is finishing. Send the text as a new task.");
    if (this.queued.length + this.inFlight.size >= MAX_PENDING_INPUTS) {
      throw new Error("The current run has reached its pending input limit.");
    }

    // Reserve this ID before awaiting SQLite so the completion gate sees every
    // admission attempt that preceded it, including writes still in flight.
    const result = this.recorder.acceptRunInput({ inputId, runId: this.runId, content: normalized }).then((record) => {
      if (record.state === "accepted" && !this.queuedIds.has(inputId)) {
        this.queued.push(record);
        this.queuedIds.add(inputId);
      }
      return record;
    });
    this.requests.set(inputId, { content: normalized, result });
    this.inFlight.add(result);
    void result.then(
      () => { this.inFlight.delete(result); },
      () => { this.inFlight.delete(result); this.requests.delete(inputId); },
    );
    return result;
  }

  stopAdmission(): void {
    this.accepting = false;
  }

  async takePending(): Promise<SteeringInput[]> {
    await this.settleAdmissions();
    return this.takeQueued();
  }

  async takePendingOrSeal(): Promise<SteeringInput[]> {
    await this.settleAdmissions();
    const batch = this.takeQueued();
    if (batch.length === 0) this.accepting = false;
    return batch;
  }

  closeAndAbandon(reason: RunStatus): Promise<string[]> {
    if (this.closing) return this.closing;
    this.accepting = false;
    this.closing = (async () => {
      await this.settleAdmissions();
      this.queued = [];
      this.queuedIds.clear();
      const entries = await this.recorder.abandonRunInputs(this.runId, reason);
      return entries.map((entry) => entry.id);
    })();
    return this.closing;
  }

  private async settleAdmissions(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private takeQueued(): SteeringInput[] {
    const batch = this.queued.sort((left, right) => left.acceptOrder - right.acceptOrder);
    this.queued = [];
    this.queuedIds.clear();
    return batch.map(({ inputId, content }) => ({ inputId, content }));
  }
}
