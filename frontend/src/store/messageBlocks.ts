import type { AgentState } from "./agentReducer";

export type MessageBlockKind = "user" | "assistant";

export interface MessageBlockRecord {
  runId: string;
  inputId?: string;
  turnIds?: string[];
  answerTurnId?: string;
  blockId: string;
  kind: MessageBlockKind;
  text?: string;
  showDuration?: boolean;
  isWorking?: boolean;
}

/** Group adjacent assistant turns together; only a user input starts a new work group. */
export function buildMessageBlockRecords(
  state: Pick<AgentState, "runOrder" | "runs">,
): MessageBlockRecord[] {
  return state.runOrder.flatMap((runId) => {
    const run = state.runs[runId];
    if (!run) return [];
    const records: MessageBlockRecord[] = [];
    const runIsWorking = run.status === "running" || run.status === "starting" || run.status === "stopping";
    let boundaryInputId: string | undefined;
    let turnIds: string[] = [];

    const flushAssistantGroup = (): void => {
      if (!turnIds.length || !boundaryInputId) return;
      const turns = turnIds.map((turnId) => run.turns[turnId]).filter((turn): turn is NonNullable<typeof turn> => Boolean(turn));
      const answerTurnId = run.finalTurnId && turnIds.includes(run.finalTurnId)
        ? run.finalTurnId
        : [...turns].reverse().find((turn) => turn.assistantContent && turn.stopReason !== "tool_use")?.turnId;
      const hasFinalDuration = Boolean(
        run.status === "completed"
        && run.finalTurnId
        && turnIds.includes(run.finalTurnId)
        && (run.finalDurationMs ?? run.turns[run.finalTurnId]?.assistantDurationMs) !== undefined,
      );
      const hasActivity = turns.some((turn) => (
        Boolean(turn.assistantContent)
        || Boolean(turn.reasoningContent)
        || turn.toolOrder.length > 0
      ));
      if (!runIsWorking && !hasActivity && !hasFinalDuration) {
        turnIds = [];
        return;
      }
      records.push({
        runId,
        turnIds: [...turnIds],
        answerTurnId,
        blockId: `${runId}:work:${boundaryInputId}`,
        kind: "assistant",
        text: turns.map((turn) => turn.assistantContent).filter(Boolean).join("\n"),
        showDuration: hasFinalDuration,
      });
      turnIds = [];
    };

    for (const item of run.timeline) {
      if (item.kind === "user") {
        flushAssistantGroup();
        const input = run.inputs[item.inputId];
        if (input) records.push({
          runId,
          inputId: item.inputId,
          blockId: item.inputId,
          kind: "user",
          text: input.task,
        });
        boundaryInputId = item.inputId;
      } else {
        turnIds.push(item.turnId);
      }
    }
    flushAssistantGroup();

    if (runIsWorking && boundaryInputId) {
      const last = records.at(-1);
      if (last?.kind === "assistant") {
        records[records.length - 1] = { ...last, isWorking: true };
      } else {
        records.push({
          runId,
          turnIds: [],
          blockId: `${runId}:work:${boundaryInputId}`,
          kind: "assistant",
          isWorking: true,
        });
      }
    }

    return records;
  });
}
