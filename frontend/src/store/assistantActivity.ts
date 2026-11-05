import type { RunState } from "./agentReducer";
import { projectToolActivity, type ActivityLanguage, type ToolActivity } from "./toolActivity";

function comparisonKey(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** A turn without native public prose still reads as one process sentence. */
function fallbackCommentary(purposes: string[], language: ActivityLanguage): string {
  const clauses: string[] = [];
  const seen = new Set<string>();
  for (const purpose of purposes) {
    const clause = purpose
      .replace(/^(?:我们会先|我们会|我们需要先|我们需要|我会先|我会|我需要先|我需要|我先|先|首先|然后|再|接着|随后)[，,:：\s]*/u, "")
      .replace(/^(?:(?:I|we)(?:'ll| will)\s+)?(?:first|then|next|after that)[,:]?\s+/i, "")
      .replace(/^(?:I|we)(?:'ll| will)?\s+/i, "")
      .replace(/[。！？.!?;；,，、\s]+$/u, "")
      .trim();
    const key = comparisonKey(clause);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    clauses.push(clause);
  }
  if (!clauses.length) return "";
  if (language === "zh") {
    return `本轮先${clauses[0]}${clauses.slice(1)
      .map((clause, index) => `${index === 0 ? "，再" : "，接着"}${clause}`)
      .join("")}。`;
  }
  const lower = (value: string) => value.length > 1 && /[A-Z]/.test(value[1])
    ? value
    : value.charAt(0).toLowerCase() + value.slice(1);
  return `First ${lower(clauses[0])}${clauses.slice(1)
    .map((clause) => `, then ${lower(clause)}`)
    .join("")}.`;
}

/**
 * One provider-neutral commentary block per turn. Existing public prose keeps
 * priority; ordered tool purposes supplement it without repeating known lines.
 */
function projectCommentary(progress: string, publicText: string, tools: ToolActivity[], language: ActivityLanguage): string {
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
  if (!sources.length) return fallbackCommentary(purposes, language);
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
      commentary: projectCommentary(progress, text, tools, language),
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
