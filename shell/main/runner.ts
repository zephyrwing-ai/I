import { randomUUID } from "node:crypto";
import { run, type AgentEvents } from "../../agent/loop.js";
import type { HistoryRecorder, HistoryScope } from "../../agent/memory/types.js";
import type { ModelCapabilities, ModelConfig, ModelContextConfig } from "../../agent/model/index.js";
import { loadContextPolicy } from "../../agent/context/config.js";
import { resolveContextPolicy } from "../../agent/context/policy.js";
import type { ModelMessage } from "../../agent/model/types.js";
import type { PendingRunInput } from "../../agent/memory/types.js";
import type { ResolvedCanvasContext } from "../../canvas/context/CanvasContextRegistry.js";
import type { ResolvedAttachment } from "./input-attachments.js";
import { createLocalBashOps } from "../../agent/environment.js";
import { createHistoryReadTool, createToolRegistry } from "../../agent/tools/index.js";
import { createCanvasEditTool, type CanvasEditExecutor } from "../../agent/tools/canvas-edit.js";
import type { FileArtifact } from "../../agent/types.js";
import type { AgentEvent, OutputFileDescriptor, Provider, SteerRequest } from "../shared/ipc.js";
import { toPublicToolResult } from "../shared/tool-result.js";
import { RunInputInbox } from "./run-input-inbox.js";
import { CANVAS_CODING_AGENT_PROMPT, DEFAULT_CODING_AGENT_PROMPT } from "../../agent/prompts.js";

const MAX_CANVAS_EDIT_BASE_ELEMENTS = 1_000;

export interface RunnerHandle {
  runId: string;
  stop(): void;
}

  /** Main 解析 modelOptionId 与凭据读取器后才能构造；不得暴露给 Renderer。 */
export interface ResolvedRunRequest {
  task: string;
  cwd: string;
  /** 当前历史范围；null 表示无项目历史。 */
  projectId: HistoryScope;
  projectContextVersion: string | null;
  historyRecorder: HistoryRecorder;
  modelOptionId: string;
  providerProfileId: string;
  provider: Provider;
  modelId: string;
  baseURL?: string;
  context?: ModelContextConfig;
  capabilities?: ModelCapabilities;
  getApiKey: () => Promise<string>;
  /** Main assigns this before consuming any run-scoped references. */
  runId?: string;
  /** Main assigns the persisted ID for the initial user entry. */
  initialUserEntryId?: string;
  initialUserCreatedAt?: number;
  ownerWebContentsId?: number;
  /** Project and other context that lives only in this model run and is never recorded. */
  runScopedContext?: ModelMessage[];
  canvasContexts?: ResolvedCanvasContext[];
  attachments?: ResolvedAttachment[];
}

export type ArtifactRegistrar = (
  runId: string,
  cwd: string,
  artifacts: FileArtifact[],
  projectId: HistoryScope,
) => OutputFileDescriptor[];

export class AgentRunner {
  private controller = new AbortController();
  private active = false;
  private activeRun: { runId: string; projectId: HistoryScope; ownerWebContentsId?: number; inbox: RunInputInbox; recorder: HistoryRecorder; cancellation?: Promise<void> } | null = null;
  private readonly idleResolvers = new Set<() => void>();
  // Filesystem capabilities belong to the runtime, while cwd and projectId
  // identify the current run's execution and history scopes independently.
  private readonly baseTools = createToolRegistry(createLocalBashOps());

  constructor(
    private readonly registerArtifacts?: ArtifactRegistrar,
    private readonly canvasEdit?: { execute: CanvasEditExecutor; enableCreateWithoutSelection?: boolean },
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  waitForIdle(): Promise<void> {
    if (!this.active) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.add(resolve));
  }

  start(req: ResolvedRunRequest, emit: (event: AgentEvent) => void): RunnerHandle {
    if (this.active) throw new Error("A run is already in progress. Stop the current task first.");
    const runId = req.runId ?? randomUUID();
    if (req.projectId === undefined) {
      throw new Error("The run request is missing a project scope.");
    }
    const context = req.context ? resolveContextPolicy(req.context, req.capabilities) : loadContextPolicy(process.env, req.capabilities);
    const recorder = req.historyRecorder;
    const tools = new Map(this.baseTools);
    tools.set("history_read", createHistoryReadTool(recorder.repository, req.projectId));
    if (this.canvasEdit && req.ownerWebContentsId !== undefined &&
        ((req.canvasContexts?.length ?? 0) > 0 || this.canvasEdit.enableCreateWithoutSelection)) {
      const sourceElements = selectedCanvasElements(req.canvasContexts ?? [], req.projectId);
      tools.set("canvas_edit", createCanvasEditTool({
        runId,
        projectId: req.projectId,
        ownerWebContentsId: req.ownerWebContentsId,
        sourceElements,
        imageAttachments: req.attachments,
        execute: this.canvasEdit.execute,
      }));
    }
    this.controller = new AbortController();
    this.active = true;
    const inbox = new RunInputInbox(runId, req.projectId, recorder);
    const activeRun = { runId, projectId: req.projectId, ownerWebContentsId: req.ownerWebContentsId, inbox, recorder } as NonNullable<AgentRunner["activeRun"]>;
    this.activeRun = activeRun;
    const emitOnce = (() => {
      let completed = false;
      return (event: AgentEvent) => {
        if (event.type === "runCompleted") {
          if (completed) return;
          completed = true;
          this.markIdle();
        }
        emit(event);
      };
    })();

    const events: AgentEvents = {
      onRunStart: (ctx) => emitOnce({ type: "runStarted", ...ctx }),
      onTurnStart: (ctx) => emitOnce({ type: "turnStarted", ...ctx }),
      onReasoningDelta: (delta, ctx) => emitOnce({ type: "reasoningDelta", ...ctx, delta }),
      onProgressDelta: (delta, ctx) => emitOnce({ type: "progressDelta", ...ctx, delta }),
      onAssistantDelta: (delta, ctx) => emitOnce({ type: "assistantDelta", ...ctx, delta }),
      onAssistantCompleted: (response, ctx) => emitOnce({ type: "assistantCompleted", ...ctx, content: response.content, ...(response.progress !== undefined ? { progress: response.progress } : {}), toolCalls: response.toolCalls, stopReason: response.stopReason }),
      onToolStart: (call, ctx) => emitOnce({ type: "toolStarted", runId: ctx.runId, turnId: ctx.turnId, toolCallId: call.id, name: call.name, input: call.input }),
      onToolCompleted: (call, result, ctx) => {
        emitOnce({
          type: "toolCompleted",
          runId: ctx.runId,
          turnId: ctx.turnId,
          toolCallId: call.id,
          name: call.name,
          result: toPublicToolResult(result),
        });
        if (result.artifacts?.length && this.registerArtifacts) {
          const files = this.registerArtifacts(ctx.runId, req.cwd, result.artifacts, req.projectId);
          for (const file of files) emitOnce({ type: "outputFileRegistered", runId: ctx.runId, file });
        }
      },
      onTurnRetrying: (ctx) => emitOnce({ type: "turnRetrying", ...ctx }),
      onTurnCompleted: (ctx) => emitOnce({ type: "turnCompleted", ...ctx }),
      onInputsApplied: (result) => emitOnce({ type: "inputsApplied", ...result }),
      onRunCompleted: (result) => emitOnce({ type: "runCompleted", ...result }),
    };

    // 只有 OpenAI 兼容协议一种运行时：provider 固定为 "openai"（历史 profile 上
    // 线的 provider 字段只用于展示，不决定请求协议）。
    const modelConfig: ModelConfig = {
      provider: "openai",
      model: req.modelId,
      capabilities: req.capabilities,
      context,
      openai: {
        baseURL: req.baseURL,
        apiKeyProvider: req.getApiKey,
        reasoningField: req.baseURL?.toLowerCase().includes("deepseek") ? "reasoning_content" : undefined,
      },
    };

    // Let the invoke handler return the runId before the first event reaches
    // Renderer; otherwise a synchronous runStarted can arrive before the
    // renderer has accepted the new run.
    setImmediate(() => {
      void run(req.task, modelConfig, {
        runId,
        systemPrompt: tools.has("canvas_edit") ? CANVAS_CODING_AGENT_PROMPT : DEFAULT_CODING_AGENT_PROMPT,
        cwd: req.cwd,
        tools,
        signal: this.controller.signal,
        recorder,
        initialUserEntryId: req.initialUserEntryId,
        initialUserCreatedAt: req.initialUserCreatedAt,
        steeringInbox: inbox,
        cancellationBarrier: () => activeRun.cancellation ?? Promise.resolve(),
        runScopedContext: [
          ...(req.runScopedContext ?? []),
          ...(req.canvasContexts?.map(toModelMessage) ?? []),
        ],
      }, events).catch(async (error: unknown) => {
        let unappliedInputIds: string[] = [];
        try {
          unappliedInputIds = await inbox.closeAndAbandon("failed");
        } catch {
          // Startup recovery reclassifies any durable inputs left accepted.
        }
        emitOnce({ type: "runCompleted", runId, status: "failed", turnCount: 0, error: { kind: "runtime", message: error instanceof Error ? error.message : String(error) }, ...(unappliedInputIds.length ? { unappliedInputIds } : {}) });
      });
    });

    return { runId, stop: () => this.stop() };
  }

  async steer(request: SteerRequest, senderWebContentsId?: number): Promise<PendingRunInput> {
    const active = this.activeRun;
    if (!this.active || !active || active.runId !== request.runId || active.projectId !== request.projectId) {
      throw new Error("The selected run has finished or belongs to another project.");
    }
    if (active.ownerWebContentsId !== undefined && active.ownerWebContentsId !== senderWebContentsId) {
      throw new Error("The selected run belongs to another window.");
    }
    return active.inbox.accept(request.inputId, request.task);
  }

  stop(senderWebContentsId?: number): void {
    if (senderWebContentsId !== undefined
      && this.activeRun?.ownerWebContentsId !== undefined
      && this.activeRun.ownerWebContentsId !== senderWebContentsId) return;
    if (this.active) {
      const active = this.activeRun;
      active?.inbox.stopAdmission();
      if (active && !active.cancellation) {
        try {
          active.cancellation = active.recorder.requestRunCancellation(active.runId);
        } catch (error) {
          active.cancellation = Promise.reject(error);
        }
        // Runtime observes the original promise and reports storage failure.
        // IPC's fire-and-forget stop listener must never throw or reject.
        void active.cancellation.catch(() => undefined);
      }
      this.controller.abort();
    }
  }

  private markIdle(): void {
    if (!this.active) return;
    this.active = false;
    this.activeRun = null;
    for (const resolve of this.idleResolvers) resolve();
    this.idleResolvers.clear();
  }
}

function selectedCanvasElements(contexts: ResolvedCanvasContext[], projectId: HistoryScope): Record<string, unknown>[] {
  const elements = new Map<string, Record<string, unknown>>();
  for (const context of contexts) {
    if (context.descriptor.projectId !== projectId) throw new Error("The Canvas selection belongs to another project.");
    const parsed = JSON.parse(context.text) as { elements?: unknown };
    if (!Array.isArray(parsed.elements)) throw new Error("The Canvas selection is invalid.");
    for (const element of parsed.elements) {
      if (!element || typeof element !== "object" || Array.isArray(element) ||
          typeof (element as Record<string, unknown>).id !== "string") {
        throw new Error("The Canvas selection contains an invalid element.");
      }
      elements.set((element as Record<string, unknown>).id as string, element as Record<string, unknown>);
      if (elements.size > MAX_CANVAS_EDIT_BASE_ELEMENTS) {
        throw new Error(`Canvas Edit supports at most ${MAX_CANVAS_EDIT_BASE_ELEMENTS} referenced elements per Run.`);
      }
    }
  }
  return [...elements.values()];
}

function toModelMessage(context: ResolvedCanvasContext): ModelMessage {
  return {
    role: "user",
    content: `Canvas selection JSON for this run:\n${context.text}`,
    ...(context.visual ? { media: { mediaType: context.visual.mediaType, dataUrl: context.visual.dataURL } } : {}),
  };
}
