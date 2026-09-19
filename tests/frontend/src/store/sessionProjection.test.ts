import assert from "node:assert/strict";
import test from "node:test";
import { mergePersistedEntries } from "../../../../frontend/src/store/sessionProjection";
import {
  buildVirtualMessageLayout,
  calculateVirtualMessageRange,
  scrollToBottomInstant,
  shouldStickToBottom,
} from "../../../../frontend/src/middle-column/message-stream/useVirtualMessageWindow";
import type { SessionHistoryEntry } from "../../../../shell/shared/ipc";

function entry(partial: Partial<SessionHistoryEntry> & Pick<SessionHistoryEntry, "entryId" | "sessionSeq" | "type" | "runId" | "payload">): SessionHistoryEntry {
  return {
    entryId: partial.entryId,
    sessionSeq: partial.sessionSeq,
    type: partial.type,
    status: partial.status ?? "completed",
    runId: partial.runId,
    turnId: partial.turnId ?? null,
    toolCallId: partial.toolCallId ?? null,
    revision: partial.revision ?? 0,
    payload: partial.payload,
    createdAt: partial.createdAt ?? partial.sessionSeq,
    updatedAt: partial.updatedAt ?? partial.sessionSeq,
  };
}

test("history projection rebuilds runs, turns and tool results from persisted entries", () => {
  const projected = mergePersistedEntries({ runs: {}, runOrder: [] }, [
    entry({ entryId: "u1", sessionSeq: 1, type: "user_message", runId: "run-1", payload: { role: "user", content: "读取文件" } }),
    entry({
      entryId: "a1",
      sessionSeq: 2,
      type: "assistant_message",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_234,
      payload: {
        role: "assistant",
        content: "我来读取。",
        reasoning: "需要先查看文件。",
        toolCalls: [{ id: "call-1", name: "read", input: { path: "README.md" }, inputComplete: true }],
      },
    }),
    entry({
      entryId: "t1",
      sessionSeq: 3,
      type: "tool_result",
      runId: "run-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      payload: { role: "tool", content: "内容", toolCallId: "call-1", toolName: "read" },
    }),
  ]);

  const run = projected.runs["run-1"]!;
  const turn = run.turns["turn-1"]!;
  assert.deepEqual(projected.runOrder, ["run-1"]);
  assert.equal(run.task, "读取文件");
  assert.equal(turn.assistantAt, 1_700_000_001_234);
  assert.equal(turn.reasoningContent, "需要先查看文件。");
  assert.equal(turn.tools["call-1"]?.status, "completed");
  assert.equal(turn.tools["call-1"]?.result?.output, "内容");
});

test("virtual message range keeps a bounded window and spacer sizes", () => {
  const layout = buildVirtualMessageLayout(
    Array.from({ length: 100 }, (_, index) => ({ blockId: `block-${index}`, estimatedHeight: 20 })),
    new Map(),
  );
  const range = calculateVirtualMessageRange(layout, 1000, 100, 40);
  assert.ok(range.startIndex > 0);
  assert.ok(range.endIndex - range.startIndex < 20);
  assert.equal(range.topSpacer, range.startIndex * 20);
  assert.equal(range.topSpacer + (range.endIndex - range.startIndex) * 20 + range.bottomSpacer, layout.totalSize);
});

test("stream auto-follow stops once the user leaves the bottom threshold", () => {
  assert.equal(shouldStickToBottom(900, 1000, 1900), true);
  assert.equal(shouldStickToBottom(876, 1000, 1900), true);
  assert.equal(shouldStickToBottom(875, 1000, 1900), false);
});

test("initial latest positioning is instant rather than animated", () => {
  const calls: Array<{ top: number; behavior: string }> = [];
  scrollToBottomInstant({
    scrollHeight: 1900,
    scrollTo(options: { top: number; behavior: string }) {
      calls.push(options);
    },
  });
  assert.deepEqual(calls, [{ top: 1900, behavior: "instant" }]);
});
