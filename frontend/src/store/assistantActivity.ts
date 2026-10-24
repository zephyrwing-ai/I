import type { RunState } from "./agentReducer";
import { projectToolActivity, type ActivityLanguage } from "./toolActivity";

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
    return [{
      turnId,
      // Stored progress remains readable alongside native provider content.
      progress: turn.progressContent ?? "",
      text: turnId === answerTurnId ? "" : turn.assistantContent,
      tools,
      toolsRunning: isWorking && turn.status === "running"
        && turn.toolOrder.some((id) => turn.tools[id]?.status === "running"),
    }];
  });
  const hasActivity = turns.some((turn) => turn.progress.trim() || turn.text.trim() || turn.tools.length);
  const hasReasoningNotice = !hasActivity && !isWorking && Boolean(answerTurnId && run.turns[answerTurnId]?.assistantContent.trim())
    && turnIds.some((id) => run.turns[id]?.reasoningContent.trim());
  return { turns, hasActivity, hasReasoningNotice };
}
