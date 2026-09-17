import { randomUUID } from "node:crypto";
import { run, type AgentEvents } from "../../agent/loop.js";
import type { SessionRecorder } from "../../agent/memory/types.js";
import type { ModelConfig } from "../../agent/model/index.js";
import { createLocalBashOps } from "../../agent/environment.js";
import { createToolRegistry, type ToolResult as InternalToolResult } from "../../agent/tools/index.js";
import type { FileArtifact } from "../../agent/types.js";
import type { AgentEvent, OutputFileDescriptor, Provider, ToolResult } from "../shared/ipc.js";

const SYSTEM_PROMPT = "You are a coding agent. Use the available tools when needed, then provide a concise final answer.";

export interface RunnerHandle {
  runId: string;
  stop(): void;
}

/** Main 解析 modelOptionId 与凭据后才能构造；不得暴露给 Renderer。 */
export interface ResolvedRunRequest {
  task: string;
  cwd: string;
  /** 会话路由提供的稳定后台会话身份。Main 接入持久化后填充。 */
  sessionId?: string;
  modelOptionId: string;
  providerProfileId: string;
  provider: Provider;
  modelId: string;
  baseURL?: string;
  apiKey: string;
}

export type ArtifactRegistrar = (
  runId: string,
  cwd: string,
  artifacts: FileArtifact[],
) => OutputFileDescriptor[];

export type SessionRecorderFactory = (sessionId: string, runId: string) => SessionRecorder;

export class AgentRunner {
  private controller = new AbortController();
  private active = false;
  private readonly idleResolvers = new Set<() => void>();

  constructor(
    private readonly registerArtifacts?: ArtifactRegistrar,
    private readonly createSessionRecorder?: SessionRecorderFactory,
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  waitForIdle(): Promise<void> {
    if (!this.active) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.add(resolve));
  }

  start(req: ResolvedRunRequest, emit: (event: AgentEvent) => void): RunnerHandle {
    if (this.active) throw new Error("已有运行正在进行，请先停止当前任务。");
    this.active = true;
    this.controller = new AbortController();
    const runId = randomUUID();
    if (this.createSessionRecorder && !req.sessionId) {
      this.markIdle();
      throw new Error("运行请求缺少会话身份。");
    }
    let recorder: SessionRecorder | undefined;
    try {
      recorder = this.createSessionRecorder?.(req.sessionId!, runId);
    } catch (error) {
      this.markIdle();
      throw error;
    }
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
      onAssistantDelta: (delta, ctx) => emitOnce({ type: "assistantDelta", ...ctx, delta }),
      onAssistantCompleted: (response, ctx) => emitOnce({ type: "assistantCompleted", ...ctx, content: response.content, toolCalls: response.toolCalls, stopReason: response.stopReason }),
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
          const files = this.registerArtifacts(ctx.runId, req.cwd, result.artifacts);
          for (const file of files) emitOnce({ type: "outputFileRegistered", runId: ctx.runId, file });
        }
      },
      onTurnRetrying: (ctx) => emitOnce({ type: "turnRetrying", ...ctx }),
      onTurnCompleted: (ctx) => emitOnce({ type: "turnCompleted", ...ctx }),
      onRunCompleted: (result) => emitOnce({ type: "runCompleted", ...result }),
    };

    // 只有 OpenAI 兼容协议一种运行时：provider 固定为 "openai"（历史 profile 上
    // 线的 provider 字段只用于展示，不决定请求协议）。
    const modelConfig: ModelConfig = {
      provider: "openai",
      model: req.modelId,
      openai: {
        baseURL: req.baseURL,
        apiKey: req.apiKey,
        reasoningField: req.baseURL?.toLowerCase().includes("deepseek") ? "reasoning_content" : undefined,
      },
    };

    // Let the invoke handler return the runId before the first event reaches
    // Renderer; otherwise a synchronous runStarted can arrive before the
    // renderer has accepted the new run.
    setImmediate(() => {
      void run(req.task, modelConfig, {
        runId,
        systemPrompt: SYSTEM_PROMPT,
        cwd: req.cwd,
        tools: createToolRegistry(createLocalBashOps()),
        signal: this.controller.signal,
        recorder,
      }, events).catch((error: unknown) => {
        emitOnce({ type: "runCompleted", runId, status: "failed", turnCount: 0, error: { kind: "runtime", message: error instanceof Error ? error.message : String(error) } });
      });
    });

    return { runId, stop: () => this.controller.abort() };
  }

  stop(): void {
    if (this.active) this.controller.abort();
  }

  private markIdle(): void {
    if (!this.active) return;
    this.active = false;
    for (const resolve of this.idleResolvers) resolve();
    this.idleResolvers.clear();
  }
}

function toPublicToolResult(result: InternalToolResult): ToolResult {
  return {
    ok: result.ok,
    output: result.output,
    returncode: result.returncode,
    truncated: result.truncated,
    error: result.error,
  };
}
