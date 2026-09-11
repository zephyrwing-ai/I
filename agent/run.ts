import { randomUUID } from "node:crypto";
import { run } from "./loop.js";
import { createTransientSessionRecorder } from "./memory/index.js";
import { createLocalBashOps } from "./environment.js";
import { createToolRegistry } from "./tools/index.js";

const args = process.argv.slice(2);

const task = args.join(" ").trim();
if (!task) {
  console.error("用法: npx tsx agent/run.ts '任务描述'");
  process.exit(1);
}

const runId = randomUUID();
const recorder = await createTransientSessionRecorder();
let result;
try {
  result = await run(task, {
    provider: "openai",
    model: "deepseek-chat",
    openai: { baseURL: process.env.DEEPSEEK_BASE_URL },
  }, {
    runId,
    systemPrompt: "You are a coding agent. Use the available tools when needed, then provide a concise final answer.",
    cwd: process.cwd(),
    tools: createToolRegistry(createLocalBashOps()),
    recorder,
  }, {
    onTurnStart: ({ turnOrdinal }) => console.log(`\n── 回合 ${turnOrdinal} ──`),
    onReasoningDelta: (delta) => process.stdout.write(`🤔 ${delta}`),
    onAssistantCompleted: ({ content, toolCalls }) => console.log(`\n🤖 ${content}\n工具调用：${toolCalls.length}`),
    onToolStart: (call) => console.log(`🔧 ${call.name} ${JSON.stringify(call.input)}`),
    onToolCompleted: (_call, toolResult) => console.log(`${toolResult.ok ? "✓" : "✗"} rc=${toolResult.returncode}`),
    onRunCompleted: ({ status, turnCount, error }) => console.log(`\n${status} — ${turnCount} 回合${error ? `：${error.message}` : ""}`),
  });
} finally {
  await recorder.close();
}

if (result.status === "failed") process.exitCode = 1;
