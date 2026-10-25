import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { run } from "../../../../agent/loop.js";
import { SqliteHistoryRepository, createHistoryRecorder } from "../../../../agent/memory/index.js";
import { HistoryService } from "../../../../shell/main/session-history.js";
import type { AgentEvent } from "../../../../shell/shared/ipc.js";
import { agentReducer, initialAgentState } from "../../../../frontend/src/store/agentReducer.js";
import { AssistantMessage } from "../../../../frontend/src/middle-column/message-stream/AssistantMessage.js";

test("live and reloaded messages render the same authoritative dates and copy actions", async () => {
  const createdAt = new Date(2026, 9, 5, 7, 24).getTime();
  const completedAt = new Date(2026, 9, 5, 7, 25).getTime();
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  let state = agentReducer(initialAgentState, {
    type: "runAccepted", runId: "run", inputId: "input", projectId: null, task: "task", taskAt: createdAt,
  });
  const emit = (event: AgentEvent): void => { state = agentReducer(state, { type: "event", event }); };
  let now = createdAt + 500;
  try {
    await run("task", { provider: "openai", model: "fake" }, {
      runId: "run", initialUserEntryId: "input", initialUserCreatedAt: createdAt,
      recorder, clock: () => now, cwd: "/tmp", systemPrompt: "", tools: new Map(),
      responseImpl: async function* () {
        yield { type: "text_delta", delta: "answer" };
        const running = state.runs.run;
        const streamingHtml = renderToStaticMarkup(createElement(AssistantMessage, {
          run: running, turnIds: Object.keys(running.turns), answerTurnId: Object.keys(running.turns)[0], isWorking: true,
        }));
        assert.match(streamingHtml, /work-commentary-text/);
        assert.doesNotMatch(streamingHtml, /aria-label="Copy answer"/);
        assert.doesNotMatch(streamingHtml, /class="message-time"/);
        now = completedAt;
        yield { type: "completed", content: "answer", toolCalls: [], stopReason: "stop" };
      },
    }, {
      onRunStart: (context) => emit({ type: "runStarted", ...context }),
      onTurnStart: (context) => emit({ type: "turnStarted", ...context }),
      onAssistantDelta: (delta, context) => emit({ type: "assistantDelta", ...context, delta }),
      onAssistantCompleted: (response, context) => emit({ type: "assistantCompleted", ...context, ...response }),
      onTurnCompleted: (context) => emit({ type: "turnCompleted", ...context }),
      onRunCompleted: (result) => emit({ type: "runCompleted", ...result }),
    });
    const page = await new HistoryService(() => null, repository).loadPage({ cursor: null, limit: 100 });
    const hydrated = agentReducer(initialAgentState, { type: "historyHydrated", page, generation: 0 });
    const liveRun = state.runs.run;
    const historyRun = hydrated.runs.run;
    assert.equal(liveRun.inputs.input.at, createdAt);
    assert.equal(historyRun.inputs.input.at, createdAt);
    assert.equal(liveRun.turns[liveRun.finalTurnId!].assistantAt, completedAt);
    assert.equal(historyRun.turns[historyRun.finalTurnId!].assistantAt, completedAt);
    for (const current of [liveRun, historyRun]) {
      const html = renderToStaticMarkup(createElement(AssistantMessage, {
        run: current, turnIds: Object.keys(current.turns), answerTurnId: current.finalTurnId,
      }));
      assert.match(html, /Mon Oct 5 7:25 AM/);
      assert.match(html, /aria-label="Copy answer"/);
    }
  } finally {
    await recorder.close();
    repository.close();
  }
});
