import { randomUUID } from "node:crypto";
import { run } from "./loop.js";
import { createTransientHistoryRecorder } from "./memory/index.js";
import { createLocalBashOps } from "./environment.js";
import { createHistoryReadTool, createToolRegistry } from "./tools/index.js";
import { loadContextPolicy } from "./context/config.js";
import { lookupModelCapabilities } from "./model/catalog.js";
import { DEFAULT_CODING_AGENT_PROMPT } from "./prompts.js";

const args = process.argv.slice(2);

const task = args.join(" ").trim();
if (!task) {
  console.error("Usage: npx tsx agent/run.ts 'task description'");
  process.exit(1);
}

const runId = randomUUID();
const modelId = process.env.I_MODEL_ID ?? "deepseek-chat";
const capabilities = lookupModelCapabilities(process.env.DEEPSEEK_BASE_URL, modelId);
const context = loadContextPolicy(process.env, capabilities);
const recorder = await createTransientHistoryRecorder();
const tools = createToolRegistry(createLocalBashOps());
tools.set("history_read", createHistoryReadTool(recorder.repository, recorder.projectId));
let result;
try {
  result = await run(task, {
    provider: "openai",
    model: modelId,
    capabilities,
    context,
    openai: { baseURL: process.env.DEEPSEEK_BASE_URL, reasoningField: "reasoning_content" },
  }, {
    runId,
    systemPrompt: DEFAULT_CODING_AGENT_PROMPT,
    cwd: process.cwd(),
    tools,
    recorder,
  }, {
    onTurnStart: ({ turnOrdinal }) => console.log(`\n── Turn ${turnOrdinal} ──`),
    onReasoningDelta: (delta) => process.stdout.write(`🤔 ${delta}`),
    onProgressDelta: (delta) => process.stdout.write(delta),
    onAssistantCompleted: ({ content, toolCalls }) => console.log(`\n🤖 ${content}\nTool calls: ${toolCalls.length}`),
    onToolStart: (call) => console.log(`🔧 ${call.name} ${JSON.stringify(call.input)}`),
    onToolCompleted: (_call, toolResult) => console.log(`${toolResult.ok ? "✓" : "✗"} rc=${toolResult.returncode}`),
    onRunCompleted: ({ status, turnCount, error }) => console.log(`\n${status} — ${turnCount} turns${error ? `: ${error.message}` : ""}`),
  });
} finally {
  await recorder.close();
}

if (result.status === "failed") process.exitCode = 1;
