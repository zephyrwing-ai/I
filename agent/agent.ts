/**
 * Agent 层 — while 循环。
 *
 * 设计原则：
 * - Agent 只管"问 → 解析 → 执行 → 喂结果"这个循环。
 * - Agent 不画 UI。所有外部反馈通过 events 回调发出。
 * - CLI / Electron / TUI 各自实现 events，Agent 核心不感知。
 */

import { query, type ModelConfig } from "./model/index.js";
import type { BashOperations, ExecResult } from "./types.js";

// ── 类型 ──

export interface StepContext {
  stepNumber: number;
  messageCount: number;
}

export interface ActionContext {
  stepNumber: number;
  command: string;
  result: ExecResult;
}

export interface DoneContext {
  status: "completed" | "step_limit" | "error";
  totalSteps: number;
}

/** 订阅者实现这些回调来决定"长什么样"。Agent 不关心。 */
export interface AgentEvents {
  onTurnStart?: (ctx: StepContext) => void;
  onLlmResponse?: (content: string, actions: Array<{ command: string }>, ctx: StepContext) => void;
  onActionStart?: (command: string, ctx: StepContext) => void;
  onActionDone?: (ctx: ActionContext) => void;
  onAgentDone?: (ctx: DoneContext) => void;
}

export interface AgentConfig {
  stepLimit: number;
  systemPrompt: string;
  /** 命令执行目录。默认 process.cwd()。桌面 app 传入用户选的工作目录。 */
  cwd?: string;
  /** 取消信号。abort 后循环在下一个检查点结束并回 error。 */
  signal?: AbortSignal;
}

const DEFAULT_PROMPT = `You are a coding agent. You can run bash commands.
Reply with:
THOUGHT: <your reasoning>
COMMAND: <bash command>
When done, reply with: DONE: <summary>`;

// ── 核心循环 ──

export async function run(
  task: string,
  ops: BashOperations,
  modelConfig: ModelConfig,
  events: AgentEvents = {},
  agentConfig: AgentConfig = { stepLimit: 20, systemPrompt: DEFAULT_PROMPT },
): Promise<DoneContext> {
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: agentConfig.systemPrompt },
    { role: "user", content: task },
  ];
  const cwd = agentConfig.cwd ?? process.cwd();
  const signal = agentConfig.signal;

  for (let i = 0; i < agentConfig.stepLimit; i++) {
    // 取消：在每回合边界检查，abort 后不再发起新一轮。
    if (signal?.aborted) {
      const done: DoneContext = { status: "error", totalSteps: i };
      events.onAgentDone?.(done);
      return done;
    }

    const stepCtx: StepContext = { stepNumber: i + 1, messageCount: messages.length };

    events.onTurnStart?.(stepCtx);

    const resp = await query(modelConfig, messages, agentConfig.systemPrompt);
    messages.push({ role: "assistant", content: resp.content });

    events.onLlmResponse?.(resp.content, resp.actions, stepCtx);

    if (resp.actions.length === 0) {
      const done: DoneContext = { status: "completed", totalSteps: i + 1 };
      events.onAgentDone?.(done);
      return done;
    }

    for (const action of resp.actions) {
      events.onActionStart?.(action.command, stepCtx);

      const result = await ops.exec(action.command, cwd, { timeout: 30, signal });

      let outputText = `<returncode>${result.returncode}</returncode>\n<output>\n${result.output}\n</output>`;
      if (result.truncated) {
        outputText += `\n<note>输出被截断。完整内容: ${result.fullOutputPath}</note>`;
      }
      messages.push({ role: "user", content: outputText });

      events.onActionDone?.({ stepNumber: i + 1, command: action.command, result });
    }
  }

  const done: DoneContext = { status: "step_limit", totalSteps: agentConfig.stepLimit };
  events.onAgentDone?.(done);
  return done;
}
