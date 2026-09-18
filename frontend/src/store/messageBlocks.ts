import type { AgentState, RunState, TurnState } from "./agentReducer";

export type MessageBlockKind = "user" | "process" | "assistant";

export interface MessageBlockRecord {
  runId: string;
  turnId?: string;
  blockId: string;
  kind: MessageBlockKind;
  text?: string;
}

export function selectAnswerTurn(run: RunState): TurnState | undefined {
  const turns = run.turnOrder
    .map((turnId) => run.turns[turnId])
    .filter((turn): turn is TurnState => Boolean(turn));
  const finalTurn = [...turns].reverse().find(
    (turn) => turn.status === "completed" && turn.toolOrder.length === 0,
  );
  const runningTurn = turns[turns.length - 1];
  return runningTurn?.status === "running" && runningTurn.toolOrder.length === 0
    ? runningTurn
    : finalTurn;
}

export function buildMessageBlockRecords(
  state: Pick<AgentState, "runOrder" | "runs">,
): MessageBlockRecord[] {
  return state.runOrder.flatMap((runId) => {
    const run = state.runs[runId];
    if (!run) return [];
    const records: MessageBlockRecord[] = [];
    if (run.task) records.push({ runId, blockId: `${runId}:task`, kind: "user", text: run.task });
    records.push({ runId, blockId: `${runId}:process`, kind: "process" });
    const answerTurn = selectAnswerTurn(run);
    if (answerTurn?.assistantContent) {
      records.push({
        runId,
        turnId: answerTurn.turnId,
        blockId: `${runId}:answer:${answerTurn.turnId}`,
        kind: "assistant",
        text: answerTurn.finalContent ?? answerTurn.assistantContent,
      });
    }
    return records;
  });
}
