import OpenAI from "openai";
function toOpenAITool(t) {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }
  };
}
async function queryOpenAI(messages, tools, config = {}) {
  const apiKey = config.apiKey ?? process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "未提供 API Key。请在桌面端「设置」面板填入，或设置 DEEPSEEK_API_KEY / OPENAI_API_KEY 环境变量。"
    );
  }
  const client = new OpenAI({
    baseURL: config.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    apiKey
  });
  const resp = await client.chat.completions.create({
    model: config.model ?? "deepseek-chat",
    messages,
    tools: tools.map(toOpenAITool)
  });
  const actions = [];
  const choice = resp.choices[0];
  const textParts = [choice.message.content ?? ""];
  for (const tc of choice.message.tool_calls ?? []) {
    if (tc.function.name === "bash") {
      try {
        const args = JSON.parse(tc.function.arguments);
        if (typeof args.command === "string") {
          actions.push({ command: args.command });
        }
      } catch {
      }
    }
  }
  return { content: textParts.join("\n"), actions };
}
export {
  queryOpenAI
};
