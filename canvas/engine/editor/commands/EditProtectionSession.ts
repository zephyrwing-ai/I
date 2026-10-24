export type HumanEditToken = symbol;

export interface EditProtectionState {
  phase: "waiting" | "applying";
  requestId: string;
  epoch: number;
  elementIds: ReadonlySet<string>;
}

export type EditProtectionErrorCode =
  | "busy"
  | "cancelled"
  | "deadline_exceeded"
  | "scene_changed"
  | "destroyed"
  | "invalid_async_apply";

export class EditProtectionError extends Error {
  constructor(public readonly code: EditProtectionErrorCode) {
    super(`Canvas edit protection: ${code}`);
    this.name = "EditProtectionError";
  }
}

export interface AgentEditProtectionContext {
  /** Call after preparing a batch, before any live scene mutation. */
  ensureAffected(elementIds: Iterable<string>): void;
  /** Revalidate the scene lifetime immediately before committing. */
  ensureCurrent(): void;
}

interface AgentEditRequest<T> {
  requestId: string;
  epoch: number;
  deadlineAt: number;
  signal?: AbortSignal;
  getAffectedIds: () => Iterable<string>;
  /** Preparation and commit share one synchronous turn of the editor. */
  apply: (context: AgentEditProtectionContext) => T;
}

interface ActiveAgentEdit {
  requestId: string;
  epoch: number;
  deadlineAt: number;
  elementIds: Set<string>;
  phase: EditProtectionState["phase"];
  failure?: EditProtectionError;
  wake?: () => void;
}

interface EditProtectionOptions {
  getEpoch: () => number;
  /** Notifications coalesce in a microtask; state queries remain synchronous. */
  onChange?: (state: EditProtectionState | null) => void;
}

class RetryAffectedScope extends Error {}

/**
 * Owns one transient Agent lease and the active human gestures in a scene.
 * Existing gestures finish their held scope; reservations prevent new overlap.
 * Element/document locks, undo state, persistence and request queues stay with
 * their respective owners.
 */
export class EditProtectionSession {
  private readonly humanEdits = new Map<HumanEditToken, Set<string>>();
  private agentEdit: ActiveAgentEdit | null = null;
  private destroyed = false;
  private notificationScheduled = false;

  constructor(private readonly options: EditProtectionOptions) {}

  get isActive(): boolean {
    return this.agentEdit !== null;
  }

  getState(): EditProtectionState | null {
    const edit = this.agentEdit;
    return edit
      ? {
          phase: edit.phase,
          requestId: edit.requestId,
          epoch: edit.epoch,
          elementIds: new Set(edit.elementIds),
        }
      : null;
  }

  canStartHumanEdit(elementIds: Iterable<string>): boolean {
    if (this.destroyed) return false;
    const protectedIds = this.agentEdit?.elementIds;
    if (!protectedIds) return true;
    for (const id of elementIds) {
      if (protectedIds.has(id)) return false;
    }
    return true;
  }

  /** History owns a complete increment rather than a continuing human gesture. */
  canApplyHistoryEdit(elementIds: Iterable<string>): boolean {
    const ids = new Set(elementIds);
    return this.canStartHumanEdit(ids) && !this.hasHumanOverlap(ids);
  }

  beginHumanEdit(elementIds: Iterable<string>): HumanEditToken | null {
    const ids = new Set(elementIds);
    if (!this.canStartHumanEdit(ids)) return null;
    const token = Symbol("canvas-human-edit");
    this.humanEdits.set(token, ids);
    return token;
  }

  updateHumanEdit(token: HumanEditToken, elementIds: Iterable<string>): boolean {
    const heldIds = this.humanEdits.get(token);
    if (!heldIds || this.destroyed) return false;
    const nextIds = new Set(elementIds);
    const protectedIds = this.agentEdit?.elementIds;
    for (const id of nextIds) {
      // A gesture acquired before the Agent reservation may finish its scope.
      if (!heldIds.has(id) && protectedIds?.has(id)) return false;
    }
    if (!sameIds(heldIds, nextIds)) {
      this.humanEdits.set(token, nextIds);
      this.agentEdit?.wake?.();
    }
    return true;
  }

  endHumanEdit(token: HumanEditToken): void {
    if (this.humanEdits.delete(token)) this.agentEdit?.wake?.();
  }

  async runAgentEdit<T>(request: AgentEditRequest<T>): Promise<T> {
    if (this.destroyed) throw new EditProtectionError("destroyed");
    if (this.agentEdit) throw new EditProtectionError("busy");

    const edit: ActiveAgentEdit = {
      requestId: request.requestId,
      epoch: request.epoch,
      deadlineAt: request.deadlineAt,
      elementIds: new Set(),
      phase: "waiting",
    };
    this.agentEdit = edit;
    const cancel = () => this.fail(edit, "cancelled");
    const deadline = setTimeout(
      () => this.fail(edit, "deadline_exceeded"),
      Math.max(0, request.deadlineAt - Date.now()),
    );
    request.signal?.addEventListener("abort", cancel, { once: true });

    try {
      if (request.signal?.aborted) cancel();
      this.ensureCurrent(edit);
      for (;;) {
        this.reserve(edit, request.getAffectedIds(), "waiting");
        this.ensureCurrent(edit);
        if (this.hasHumanOverlap(edit.elementIds)) {
          await this.waitForHumanChange(edit);
          continue;
        }

        this.reserve(edit, [], "applying");
        this.ensureCurrent(edit);
        try {
          const result = request.apply({
            ensureCurrent: () => this.ensureCurrent(edit),
            ensureAffected: (ids) => {
              this.ensureCurrent(edit);
              this.reserve(edit, ids, "applying");
              if (this.hasHumanOverlap(edit.elementIds)) {
                throw new RetryAffectedScope();
              }
            },
          });
          if (isPromiseLike(result)) {
            throw new EditProtectionError("invalid_async_apply");
          }
          return result;
        } catch (error) {
          if (!(error instanceof RetryAffectedScope)) throw error;
          this.reserve(edit, [], "waiting");
        }
      }
    } finally {
      clearTimeout(deadline);
      request.signal?.removeEventListener("abort", cancel);
      if (this.agentEdit === edit) {
        this.agentEdit = null;
        this.notifyChange();
      }
    }
  }

  /** Replacing the project scene invalidates both leases and gesture tokens. */
  reset(): void {
    this.humanEdits.clear();
    if (this.agentEdit) this.fail(this.agentEdit, "scene_changed");
    this.agentEdit = null;
    this.notifyChange();
  }

  destroy(): void {
    this.destroyed = true;
    this.humanEdits.clear();
    if (this.agentEdit) this.fail(this.agentEdit, "destroyed");
    this.agentEdit = null;
    this.notifyChange();
  }

  private ensureCurrent(edit: ActiveAgentEdit): void {
    if (edit.failure) throw edit.failure;
    if (this.destroyed) throw new EditProtectionError("destroyed");
    if (this.agentEdit !== edit || this.options.getEpoch() !== edit.epoch) {
      throw new EditProtectionError("scene_changed");
    }
    if (Date.now() >= edit.deadlineAt) {
      throw new EditProtectionError("deadline_exceeded");
    }
  }

  private reserve(
    edit: ActiveAgentEdit,
    elementIds: Iterable<string>,
    phase: EditProtectionState["phase"],
  ): void {
    this.ensureCurrent(edit);
    let changed = edit.phase !== phase;
    edit.phase = phase;
    for (const id of elementIds) {
      if (!edit.elementIds.has(id)) {
        edit.elementIds.add(id);
        changed = true;
      }
    }
    if (changed) this.notifyChange();
  }

  private hasHumanOverlap(elementIds: ReadonlySet<string>): boolean {
    for (const heldIds of this.humanEdits.values()) {
      for (const id of heldIds) {
        if (elementIds.has(id)) return true;
      }
    }
    return false;
  }

  private waitForHumanChange(edit: ActiveAgentEdit): Promise<void> {
    return new Promise((resolve) => {
      edit.wake = () => {
        edit.wake = undefined;
        resolve();
      };
    });
  }

  private fail(edit: ActiveAgentEdit, code: EditProtectionErrorCode): void {
    edit.failure ??= new EditProtectionError(code);
    edit.wake?.();
  }

  private notifyChange(): void {
    if (!this.options.onChange || this.notificationScheduled) return;
    this.notificationScheduled = true;
    queueMicrotask(() => {
      this.notificationScheduled = false;
      this.options.onChange?.(this.getState());
    });
  }
}

function sameIds(first: ReadonlySet<string>, second: ReadonlySet<string>): boolean {
  if (first.size !== second.size) return false;
  for (const id of first) {
    if (!second.has(id)) return false;
  }
  return true;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
