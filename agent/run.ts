import { randomUUID } from "node:crypto";
import { run } from "./loop.js";
import { createTransientSessionRecorder } from "./memory/index.js";
import { createLocalBashOps } from "./environment.js";
import { createToolRegistry } from "./tools/index.js";

const args = process.argv.slice(2);

const task = args.join(" ").trim();
if (!task) {
  console.error("Usage: npx tsx agent/run.ts 'task description'");
  process.exit(1);
}

const runId = randomUUID();
const recorder = await createTransientSessionRecorder();
let result;
try {
  result = await run(task, {
    provider: "openai",
    model: "deepseek-chat",
    openai: { baseURL: process.env.DEEPSEEK_BASE_URL, reasoningField: "reasoning_content" },
  }, {
    runId,
    systemPrompt: "You are a coding agent. Use the available tools when needed, then provide a concise final answer.",
    cwd: process.cwd(),
    tools: createToolRegistry(createLocalBashOps()),
    recorder,
  }, {
    onTurnStart: ({ turnOrdinal }) => console.log(`\n── Turn ${turnOrdinal} ──`),
    onReasoningDelta: (delta) => process.stdout.write(`🤔 ${delta}`),
    onAssistantCompleted: ({ content, toolCalls }) => console.log(`\n🤖 ${content}\nTool calls: ${toolCalls.length}`),
    onToolStart: (call) => console.log(`🔧 ${call.name} ${JSON.stringify(call.input)}`),
    onToolCompleted: (_call, toolResult) => console.log(`${toolResult.ok ? "✓" : "✗"} rc=${toolResult.returncode}`),
    onRunCompleted: ({ status, turnCount, error }) => console.log(`\n${status} — ${turnCount} turns${error ? `: ${error.message}` : ""}`),
  });
} finally {
  await recorder.close();
}

if (result.status === "failed") process.exitCode = 1;
