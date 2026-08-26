/**
 * 入口 — CLI 订阅者。
 * 实现 AgentEvents，用 console.log 渲染。
 * 将来换成 Electron：换掉这个文件，agent.ts 一字不动。
 *
 * 用法:
 *   npx tsx agent/run.ts "你的任务"
 *   npx tsx agent/run.ts --no-docker "你的任务"
 *   npx tsx agent/run.ts --provider openai "你的任务"
 */

import { run, type AgentEvents } from "./agent.js";
import { createLocalBashOps, createDockerBashOps } from "./environment.js";
import type { Provider } from "./model/index.js";

// ── CLI 订阅者实现 ──

const cliEvents: AgentEvents = {
  onTurnStart({ stepNumber, messageCount }) {
    console.log(`\n── 第 ${stepNumber} 步 ── ${messageCount} 条消息已累积`);
  },

  onLlmResponse(content, actions) {
    console.log(`🤖 LLM (${actions.length} 个动作):`);
    console.log(content.slice(0, 300) + (content.length > 300 ? "..." : ""));
  },

  onActionStart(command) {
    console.log(`🔧 ${command}`);
  },

  onActionDone({ command, result }) {
    const status = result.returncode === 0 ? "✓" : `✗ (rc=${result.returncode})`;
    console.log(`   ${status} ${result.output.length} 字符${result.truncated ? " [已截断]" : ""}`);
  },

  onAgentDone({ status, totalSteps }) {
    const label = { completed: "✅ 完成", step_limit: "⚠️ 达到步数限制", error: "❌ 出错" }[status];
    console.log(`\n${label} — 共 ${totalSteps} 步`);
  },
};

// ── 入口逻辑 ──

const args = process.argv.slice(2);
const useDocker = !args.includes("--no-docker");

const provIdx = args.indexOf("--provider");
let provider: Provider = "openai";
if (provIdx >= 0) {
  const raw = args[provIdx + 1] ?? "";
  if (["anthropic", "openai", "google"].includes(raw)) {
    provider = raw as Provider;
    args.splice(provIdx, 2);
  }
}

const task = args.filter(a => !a.startsWith("--")).join(" ");
if (!task) {
  console.log("用法: npx tsx agent/run.ts [--no-docker] [--provider anthropic|openai|google] '任务描述'");
  process.exit(1);
}

const ops = useDocker ? createDockerBashOps() : createLocalBashOps();

await run(task, ops, {
  provider,
  model: provider === "openai" ? "deepseek-chat" : "claude-sonnet-4-20250514",
  openai: provider === "openai"
    ? { baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com" }
    : undefined,
}, cliEvents);
