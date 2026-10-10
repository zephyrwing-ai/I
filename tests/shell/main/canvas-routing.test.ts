import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import test from "node:test";
import { SqliteHistoryRepository, createHistoryRecorder } from "../../../agent/memory/index.js";
import { AgentRunner } from "../../../shell/main/runner.js";
import { CanvasCliExecutor } from "../../../shell/main/canvas-cli-executor.js";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "../../../shell/shared/ipc.js";

function emit(response: ServerResponse, delta: Record<string, unknown>, reason: string | null): void {
  response.write(`data: ${JSON.stringify({ id: "test-response", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
}

test("desktop Canvas requests execute the CLI through the existing tool loop without a selection", { timeout: 10_000 }, async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  const requests: Array<{ tools: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: string; tool_call_id?: string }> }> = [];
  const operations = [{ action: "create", element: { type: "rectangle", x: 10, y: 20, width: 120, height: 80 } }];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (requests.length === 1) {
        emit(response, { tool_calls: [{ index: 0, id: "canvas-call", type: "function", function: { name: "canvas_edit", arguments: JSON.stringify({ operations }) } }] }, null);
        emit(response, {}, "tool_calls");
      } else {
        emit(response, { content: "Rectangle created." }, null);
        emit(response, {}, "stop");
      }
      response.end("data: [DONE]\n\n");
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let editCount = 0;
  const cli = new CanvasCliExecutor(async (owner, body) => {
      editCount += 1;
      assert.equal(owner, 42);
      assert.equal(body.projectId, null);
      assert.deepEqual(body.sourceElements, []);
      assert.deepEqual(body.operations, operations);
      return { requestId: "canvas-request", runId: body.runId, projectId: null, ok: true, createdIds: ["new-rectangle"], appliedElements: [{ id: "new-rectangle", type: "rectangle", x: 10, y: 20 }] };
    }, { cliPath: fileURLToPath(new URL("../../../canvas/cli/index.ts", import.meta.url)), execArgv: ["--import", "tsx"] });
  const runner = new AgentRunner(undefined, {
    enableCreateWithoutSelection: true,
    execute: (owner, body, signal) => cli.execute(owner, body, signal),
  });
  try {
    const events: AgentEvent[] = [];
    await new Promise<void>((resolve) => {
      runner.start({
        task: "Create a rectangle on the Canvas.", cwd: process.cwd(), projectId: null,
        projectContextVersion: null, historyRecorder: recorder, modelOptionId: "fake", providerProfileId: "fake",
        provider: "openai", modelId: "fake", baseURL: `http://127.0.0.1:${address.port}/v1`,
        getApiKey: async () => "fake-test-key", ownerWebContentsId: 42,
      }, (event) => { events.push(event); if (event.type === "runCompleted") resolve(); });
    });
    assert.equal(events.at(-1)?.type, "runCompleted");
    assert.equal((events.at(-1) as Extract<AgentEvent, { type: "runCompleted" }>).status, "completed");
    assert.equal(requests.length, 2);
    assert.equal(editCount, 1);
    assert.ok(requests[0].tools.some((tool) => tool.function.name === "canvas_edit"));
    assert.match(requests[0].messages[0].content, /Live Canvas edits use canvas_edit/);
    const toolResult = requests[1].messages.find((message) => message.role === "tool");
    assert.equal(toolResult?.tool_call_id, "canvas-call");
    assert.match(toolResult!.content, /"status":"applied"/);
    assert.deepEqual(events.filter((event) => event.type === "toolStarted").map((event) => event.name), ["canvas_edit"]);
  } finally {
    runner.stop();
    await runner.waitForIdle();
    cli.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await recorder.close();
    repository.close();
  }
});
