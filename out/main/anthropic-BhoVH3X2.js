import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic();
function toAnthropicTool(t) {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.parameters
  };
}
async function queryAnthropic(messages, system, tools, model = "claude-sonnet-4-20250514") {
  const resp = await client.messages.create({
    model,
    max_tokens: 4096,
    system,
    tools: tools.map(toAnthropicTool),
    messages
  });
  const actions = [];
  const textParts = [];
  for (const block of resp.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      if (block.name === "bash" && typeof block.input === "object" && "command" in block.input) {
        actions.push({ command: block.input.command });
      }
    }
  }
  return { content: textParts.join("\n"), actions };
}
export {
  queryAnthropic
};
