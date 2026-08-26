/**
 * AgentRunner — 把 AgentEvents 桥接为 IPC 事件流，并管理运行/取消生命周期。
 * 这一层是"CLI 订阅者"在 Electron 里的对应物：换掉 src/run.ts，agent.ts 不变。
 */

import { randomUUID } from "node:crypto";
import { run, type AgentEvents, type DoneContext } from "../../agent/agent.js";
import { createLocalBashOps, createDockerBashOps } from "../../agent/environment.js";
import type { RunRequest } from "../shared/ipc.js";

const SYSTEM_PROMPT = `You are a coding agent. You can run bash commands.
Reply with:
THOUGHT: <your reasoning>
COMMAND: <bash command>
When done, reply with: DONE: <summary>`;

export interface RunnerHandle {
  runId: string;
  stop(): void;
}

export class AgentRunner {
  private controller = new AbortController();
  private active = false;

  /**
   * 启动一次运行。emit(channel, payload) 由调用方提供（一般绑到 webContents.send）。
   * 若已有运行在跑则抛错。
   */
  start(req: RunRequest, emit: (channel: string, payload: unknown) => void): RunnerHandle {
    if (this.active) {
      throw new Error("已有运行正在进行，请先停止当前任务。");
    }
    this.active = true;
    this.controller = new AbortController();
    const runId = randomUUID();

    const events: AgentEvents = {
      onTurnStart: (ctx) =>
        emit("agent:event", { type: "turnStart", stepNumber: ctx.stepNumber, messageCount: ctx.messageCount }),
      onLlmResponse: (content, actions, ctx) =>
        emit("agent:event", { type: "llmResponse", stepNumber: ctx.stepNumber, content, actions }),
      onActionStart: (command, ctx) =>
        emit("agent:event", { type: "actionStart", stepNumber: ctx.stepNumber, command }),
      onActionDone: (ctx) =>
        emit("agent:event", {
          type: "actionDone",
          stepNumber: ctx.stepNumber,
          command: ctx.command,
          result: ctx.result,
        }),
      onAgentDone: (d) => {
        this.active = false;
        emit("agent:event", { type: "done", status: d.status, totalSteps: d.totalSteps });
      },
    };

    const ops = req.useDocker ? createDockerBashOps() : createLocalBashOps();

    run(
      req.task,
      ops,
      {
        provider: req.provider,
        model: req.model,
        openai: { baseURL: req.baseURL, apiKey: req.apiKey },
      },
      events,
      {
        stepLimit: req.stepLimit,
        systemPrompt: SYSTEM_PROMPT,
        cwd: req.cwd,
        signal: this.controller.signal,
      },
    ).catch((err) => {
      // 取消/异常导致 agent 循环抛错时补发 done，保证前端永远有一个结束事件。
      this.active = false;
      emit("agent:event", { type: "done", status: "error", totalSteps: 0 });
      console.error("[AgentRunner] run failed:", err);
    });

    return { runId, stop: () => this.controller.abort() };
  }

  stop(): void {
    if (this.active) {
      this.controller.abort();
    }
  }
}
