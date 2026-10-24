import assert from "node:assert/strict";
import test from "node:test";
import { serializeAssistantText } from "../../../agent/model/assistant-text.js";
import { toOpenAIMessages } from "../../../agent/model/openai.js";
import { estimateMessageTokens, estimateTextTokens } from "../../../agent/context/tokens.js";

test("native assistant content retains whitespace and literal former markers", () => {
  for (const content of [
    "", "  \r\n", "我先检查配置。", "The answer is ready. 🧭\n",
    "[[I_PROGRESS_V1]]\n示例\n[[I_ANSWER_V1]]\n正文",
    "```text\r\n[[I_PROGRESS_V1]]\r\n[[I_ANSWER_V1]]\r\n```\r\n",
  ]) {
    assert.equal(serializeAssistantText({ content }), content);
    assert.equal(serializeAssistantText({ content, progress: "" }), content);
  }
});

test("stored progress replays as ordinary prose while preserving both stored fields", () => {
  for (const [progress, content, expected] of [
    ["", "", ""],
    ["检查配置。", "", "检查配置。"],
    ["检查配置。", "## 结论\n配置正确。", "检查配置。\n## 结论\n配置正确。"],
    ["\r\n 过程\r\n\r", "\r\n  # 结论\n\n", "\r\n 过程\r\n\r\n\r\n  # 结论\n\n"],
  ]) {
    const stored = Object.freeze({ content, progress });
    assert.equal(serializeAssistantText(stored), expected);
    assert.deepEqual(stored, { content, progress });
  }
});

test("Provider continuation and token estimation use the same text for native and stored-progress messages", () => {
  for (const fields of [
    { content: "当前正文" },
    { progress: "旧过程", content: "旧答案" },
    { progress: "只有旧过程", content: "" },
    { progress: "", content: "直接回答" },
  ]) {
    const message = { role: "assistant" as const, ...fields, reasoning: "Private reasoning stays separate." };
    const [, wire] = toOpenAIMessages([message], "system", "reasoning_content");
    assert.equal(typeof wire.content, "string");
    assert.equal(estimateMessageTokens(message), 8 + estimateTextTokens(wire.content as string) + estimateTextTokens(message.reasoning));
    assert.equal((wire as { reasoning_content?: string }).reasoning_content, message.reasoning);
  }
});
