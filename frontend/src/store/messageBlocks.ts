import type { AgentState, RunState, TurnState } from "./agentReducer";

export type MessageBlockKind = "user" | "assistant";

interface MessageBlockIdentity {
  runId: string;
  blockId: string;
}

export interface UserMessageBlockRecord extends MessageBlockIdentity {
  kind: "user";
  inputId: string;
  text: string;
}

export interface AssistantMessageBlockRecord extends MessageBlockIdentity {
  kind: "assistant";
  anchorInputId: string;
  turnIds: string[];
  answerTurnId?: string;
  /** The externally displayed answer body is also the group's searchable text. */
  text?: string;
  showDuration: boolean;
  isWorking: boolean;
}

export type MessageBlockRecord = UserMessageBlockRecord | AssistantMessageBlockRecord;

function newAssistantGroup(runId: string, anchorInputId: string): AssistantMessageBlockRecord {
  return {
    runId,
    anchorInputId,
    blockId: `${runId}:work:${anchorInputId}`,
    kind: "assistant",
    turnIds: [],
    showDuration: false,
    isWorking: false,
  };
}

function isVisibleAnswer(turn: TurnState): boolean {
  return Boolean(turn.assistantContent.trim())
    && turn.stopReason !== "tool_use"
    && turn.toolOrder.length === 0;
}

function projectAssistantGroup(
  group: AssistantMessageBlockRecord,
  run: RunState,
  isWorking: boolean,
): AssistantMessageBlockRecord | null {
  const turns = group.turnIds.map((turnId) => run.turns[turnId]).filter((turn): turn is TurnState => Boolean(turn));
  const answerTurn = turns.find((turn) => turn.turnId === run.finalTurnId && isVisibleAnswer(turn))
    ?? [...turns].reverse().find(isVisibleAnswer);
  const showDuration = Boolean(
    run.status === "completed"
    && run.finalTurnId
    && group.turnIds.includes(run.finalTurnId)
    && (run.finalDurationMs ?? run.turns[run.finalTurnId]?.assistantDurationMs) !== undefined,
  );
  const hasActivity = turns.some((turn) => (
    Boolean(turn.assistantContent.trim())
    || Boolean(turn.reasoningContent.trim())
    || turn.toolOrder.length > 0
  ));
  if (!isWorking && !hasActivity && !showDuration) return null;

  return {
    ...group,
    answerTurnId: answerTurn?.turnId,
    text: answerTurn?.assistantContent,
    showDuration,
    isWorking,
  };
}

/** User bubbles follow timeline order; assistant groups follow applied-input boundaries. */
export function buildMessageBlockRecords(
  state: Pick<AgentState, "runOrder" | "runs">,
): MessageBlockRecord[] {
  return state.runOrder.flatMap((runId) => {
    const run = state.runs[runId];
    if (!run) return [];
    const runIsWorking = run.status === "running" || run.status === "starting" || run.status === "stopping";
    const groups = new Map<string, AssistantMessageBlockRecord>();
    let inferredInputId: string | undefined;
    let currentGroup: AssistantMessageBlockRecord | undefined;

    for (const item of run.timeline) {
      if (item.kind === "user") {
        const input = run.inputs[item.inputId];
        // Partial history and timeline-only applied inputs supply the available boundary.
        if (!input || input.status === "applied") {
          inferredInputId = item.inputId;
        }
      } else {
        const turn = run.turns[item.turnId];
        const anchorInputId = turn?.anchorInputId ?? inferredInputId;
        if (!turn || !anchorInputId) continue;
        let group = groups.get(anchorInputId);
        if (!group) {
          group = newAssistantGroup(runId, anchorInputId);
          groups.set(anchorInputId, group);
        }
        group.turnIds.push(item.turnId);
        currentGroup = group;
      }
    }

    const waitingInputId = run.appliedInputId ?? inferredInputId;
    if (runIsWorking && waitingInputId && !currentGroup) {
      currentGroup = newAssistantGroup(runId, waitingInputId);
      groups.set(waitingInputId, currentGroup);
    }

    // Place each group beside its input anchor, keeping pending bubbles after the active group.
    const records: MessageBlockRecord[] = [];
    for (const item of run.timeline) {
      if (item.kind !== "user") continue;
      const input = run.inputs[item.inputId];
      if (input) records.push({ runId, inputId: item.inputId, blockId: item.inputId, kind: "user", text: input.task });
      const group = groups.get(item.inputId);
      if (!group) continue;
      const projected = projectAssistantGroup(group, run, runIsWorking && group === currentGroup);
      if (projected) records.push(projected);
    }
    return records;
  });
}
