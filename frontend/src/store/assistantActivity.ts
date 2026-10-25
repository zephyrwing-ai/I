import type { RunState } from "./agentReducer";
import { projectToolActivity, type ActivityLanguage, type ToolActivity } from "./toolActivity";

function comparisonKey(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * One provider-neutral commentary block per turn. Existing public prose keeps
 * priority; ordered tool purposes supplement it without repeating known lines.
 */
function projectCommentary(progress: string, publicText: string, tools: ToolActivity[]): string {
  // Keep source Markdown byte-for-byte; whitespace normalization exists only
  // in comparison keys so indented code blocks retain their structure.
  const sources = [progress, publicText].filter((body) => body.trim());
  const seen = new Set(sources.flatMap((body) => [body, ...body.split(/\r?\n/)]).map(comparisonKey));
  const purposes = tools.flatMap((tool) => {
    const key = comparisonKey(tool.purpose);
    if (seen.has(key)) return [];
    seen.add(key);
    return [tool.purpose];
  });
  return [...sources, ...purposes].join("\n\n");
}

/** Live events and restored entries share this disposable, chronological view. */
export function projectAssistantActivity(
  run: RunState,
  turnIds: string[],
  answerTurnId: string | undefined,
  isWorking: boolean,
  language: ActivityLanguage,
) {
  const turns = turnIds.flatMap((turnId) => {
    const turn = run.turns[turnId];
    if (!turn) return [];
    const tools = turn.toolOrder.flatMap((id) => turn.tools[id] ? [projectToolActivity(turn.tools[id], language)] : []);
    const text = turnId === answerTurnId ? "" : turn.assistantContent;
    const progress = turn.progressContent ?? "";
    return [{
      turnId,
      commentary: projectCommentary(progress, text, tools),
      tools,
      toolsRunning: isWorking && turn.status === "running"
        && turn.toolOrder.some((id) => turn.tools[id]?.status === "running"),
    }];
  });
  const hasActivity = turns.some((turn) => turn.commentary || turn.tools.length);
  const hasReasoningNotice = !hasActivity && !isWorking && Boolean(answerTurnId && run.turns[answerTurnId]?.assistantContent.trim())
    && turnIds.some((id) => run.turns[id]?.reasoningContent.trim());
  return { turns, hasActivity, hasReasoningNotice };
}
