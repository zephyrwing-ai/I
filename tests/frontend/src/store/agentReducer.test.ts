import assert from "node:assert/strict";
import test from "node:test";
import { agentReducer, initialAgentState } from "../../../../frontend/src/store/agentReducer.js";

test("agentReducer attaches output file events to their current run", () => {
  let state = agentReducer(initialAgentState, { type: "runRequested" });
  state = agentReducer(state, { type: "runAccepted", runId: "run-1" });
  state = agentReducer(state, {
    type: "event",
    event: {
      type: "outputFileRegistered",
      runId: "run-1",
      file: {
        runId: "run-1",
        fileId: "file-1",
        name: "result.md",
        displayPath: "result.md",
        operation: "created",
        mediaType: "text/markdown",
        byteSize: 12,
        updatedAt: "2026-08-31T00:00:00.000Z",
      },
    },
  });
  assert.deepEqual(state.runs["run-1"].outputFileOrder, ["file-1"]);
  assert.equal(state.runs["run-1"].outputFiles["file-1"].name, "result.md");
});
