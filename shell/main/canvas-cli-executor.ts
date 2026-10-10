import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CanvasEditResult } from "../../canvas/commands/types.js";
import { isCliRequest, isCliReply, MAX_CLI_BYTES, type CanvasCliReply } from "../../canvas/cli/protocol.js";
import { CanvasEditBridgeError, type CanvasEditRequestBody } from "./canvas-edit-bridge.js";

export type CanvasCommandExecutor = (
  ownerWebContentsId: number,
  body: CanvasEditRequestBody,
  signal?: AbortSignal,
) => Promise<CanvasEditResult>;

interface CanvasCliExecutorOptions {
  cliPath?: string;
  execPath?: string;
  execArgv?: string[];
  timeoutMs?: number;
}

/** A bundled CLI transports commands; Main retains the invocation's authority. */
export class CanvasCliExecutor {
  private readonly cliPath: string;
  private readonly execPath: string;
  private readonly execArgv: string[];
  private readonly timeoutMs: number;
  private readonly active = new Set<() => void>();
  private disposed = false;

  constructor(private readonly apply: CanvasCommandExecutor, options: CanvasCliExecutorOptions = {}) {
    this.cliPath = options.cliPath ?? fileURLToPath(new URL("./canvas-cli.js", import.meta.url));
    this.execPath = options.execPath ?? process.execPath;
    this.execArgv = [...(options.execArgv ?? [])];
    this.timeoutMs = options.timeoutMs ?? 25_000;
  }

  execute(ownerWebContentsId: number, body: CanvasEditRequestBody, signal?: AbortSignal): Promise<CanvasEditResult> {
    if (signal?.aborted) return Promise.reject(new CanvasEditBridgeError("cancelled", "The run stopped before the Canvas CLI began."));
    if (this.disposed) return Promise.reject(new CanvasEditBridgeError("canvas_unavailable", "The Canvas CLI executor has closed."));
    const snapshot = structuredClone(body);
    const operationsJSON = JSON.stringify(snapshot.operations);
    const input = JSON.stringify({ operations: snapshot.operations });
    if (Buffer.byteLength(input) > MAX_CLI_BYTES) {
      return Promise.reject(new CanvasEditBridgeError("canvas_unavailable", "The Canvas CLI command exceeds its size limit."));
    }
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      let dispatched = false;
      let child: ChildProcess | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let expectedReply: CanvasCliReply | undefined;

      const finish = (result: CanvasEditResult | Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.active.delete(onDispose);
        if (result instanceof Error) {
          controller.abort();
          if (child && child.exitCode === null && child.signalCode === null) terminateChild(child);
          reject(result);
        } else {
          resolve(result);
        }
      };
      const failure = (message: string) => new CanvasEditBridgeError(dispatched ? "outcome_unknown" : "canvas_unavailable", message);
      const onAbort = () => finish(new CanvasEditBridgeError(dispatched ? "outcome_unknown" : "cancelled", dispatched
        ? "The Canvas CLI stopped during application; its outcome could not be confirmed."
        : "The run stopped before the Canvas CLI command was applied."));
      const onDispose = () => finish(failure("The Canvas CLI executor closed before confirmation."));
      this.active.add(onDispose);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }

      try {
        child = fork(this.cliPath, ["apply"], {
          execPath: this.execPath,
          execArgv: this.execArgv,
          stdio: ["pipe", "pipe", "pipe", "ipc"],
          serialization: "json",
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        });
      } catch (error) {
        finish(failure(error instanceof Error ? error.message : String(error)));
        return;
      }
      const processChild = child;
      timer = setTimeout(() => finish(failure("The Canvas CLI exceeded its confirmation deadline.")), this.timeoutMs);
      processChild.stdout!.on("data", (data: Buffer) => {
        size += data.length;
        if (size > MAX_CLI_BYTES) finish(failure("The Canvas CLI reply exceeds its size limit."));
        else chunks.push(data);
      });
      // Diagnostics stay bounded; JSON stdout is the result contract.
      processChild.stderr!.on("data", () => undefined);
      processChild.stdin!.on("error", () => finish(failure("The Canvas CLI input channel closed.")));
      processChild.on("error", (error) => finish(failure(error.message)));
      processChild.on("message", (message: unknown) => {
        if (settled) return;
        if (dispatched || !isCliRequest(message) || JSON.stringify(message.operations) !== operationsJSON) {
          finish(failure("The Canvas CLI sent a command outside its bound invocation."));
          return;
        }
        dispatched = true;
        void Promise.resolve().then(() => this.apply(ownerWebContentsId, snapshot, controller.signal)).then((result) => {
          if (result.runId !== snapshot.runId || result.projectId !== snapshot.projectId) {
            throw new Error("The Canvas reply belongs to another run or project.");
          }
          return { kind: "canvas:result" as const, result: transportResult(result) };
        }).catch((error: unknown): CanvasCliReply => ({
          kind: "canvas:error",
          code: error instanceof CanvasEditBridgeError ? error.code : "outcome_unknown",
          message: error instanceof Error ? error.message : String(error),
        })).then((reply) => {
          if (settled) return;
          expectedReply = reply;
          try {
            processChild.send(reply, (error) => { if (error) finish(failure("The Canvas CLI result channel closed.")); });
          } catch {
            finish(failure("The Canvas CLI result channel closed."));
          }
        });
      });
      processChild.once("close", (code) => {
        if (settled) return;
        let reply: unknown;
        try { reply = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* validated below */ }
        if (!isCliReply(reply) || (dispatched && (!expectedReply || JSON.stringify(reply) !== JSON.stringify(expectedReply)))) {
          finish(failure("The Canvas CLI exited without a valid confirmation."));
        } else if (reply.kind === "canvas:error") {
          finish(code === 1 ? Object.assign(new Error(reply.message), { code: reply.code }) : failure("The Canvas CLI exited with an invalid status."));
        } else if (!dispatched || code !== (reply.result.ok ? 0 : 1)) {
          finish(failure("The Canvas CLI confirmation does not match the editor result."));
        } else {
          finish(reply.result);
        }
      });
      processChild.stdin!.end(input);
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const cancel of [...this.active]) cancel();
  }
}

function terminateChild(child: ChildProcess): void {
  const timer = setTimeout(() => child.kill("SIGKILL"), 1_000);
  timer.unref();
  child.once("close", () => clearTimeout(timer));
  child.kill();
}

/** Editor-internal scene fields stay in Main; the CLI carries the result contract. */
function transportResult(result: CanvasEditResult): CanvasEditResult {
  return {
    requestId: result.requestId,
    runId: result.runId,
    projectId: result.projectId,
    ok: result.ok,
    ...(result.changed === undefined ? {} : { changed: result.changed }),
    ...(result.appliedElements ? { appliedElements: result.appliedElements } : {}),
    ...(result.createdIds ? { createdIds: result.createdIds } : {}),
    ...(result.conflicts ? { conflicts: result.conflicts } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}
