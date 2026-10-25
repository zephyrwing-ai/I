import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { prepareAttachmentImages, streamOpenAI, toOpenAIMessages } from "../../../agent/model/openai.js";
import { readModelMessage, type ModelAttachment, type ModelMessage } from "../../../agent/model/types.js";
import { estimateMessageTokens } from "../../../agent/context/tokens.js";
import { attachmentImageKey } from "../../../agent/model/attachment-input.js";
import { run } from "../../../agent/loop.js";
import { createTransientHistoryRecorder } from "../../../agent/memory/session-recorder.js";
import { tmpdir } from "node:os";

const attachment: ModelAttachment = { attachmentId: "a".repeat(64), name: "scan.pdf", byteSize: 100, mediaType: "application/pdf", text: "Page 1: source data", imageLabels: ["Page 1"] };
const image = { mediaType: "image/jpeg", dataUrl: "data:image/jpeg;base64,AA==" };

test("user text and multiple attachment images form a single typed user message", () => {
  const message: ModelMessage = { role: "user", content: "Explain the report", attachments: [attachment] };
  assert.equal(readModelMessage(message), message);
  const request = toOpenAIMessages([message], "system", undefined, new Map([[attachmentImageKey(attachment), [image]]]));
  assert.equal(request.length, 2);
  assert.equal(request[1].role, "user");
  assert.match(JSON.stringify(request[1].content), /Explain the report/);
  assert.match(JSON.stringify(request[1].content), /Page 1: source data/);
  assert.match(JSON.stringify(request[1].content), /image_url/);
  assert.equal(message.content, "Explain the report");
  assert.ok(estimateMessageTokens(message) > estimateMessageTokens({ role: "user", content: message.content }) + 4096);
  assert.throws(() => toOpenAIMessages([message], "system"), /could not be prepared/);
});

test("tool images follow all matching tool results in a valid visual user role", () => {
  const messages: ModelMessage[] = [
    { role: "assistant", content: "", toolCalls: ["a", "b"].map((id) => ({ id, name: "read", input: {}, inputComplete: true })) },
    { role: "tool", content: "first image", toolCallId: "a", media: image },
    { role: "tool", content: "second image", toolCallId: "b", media: image },
  ];
  const request = toOpenAIMessages(messages, "system");
  assert.deepEqual(request.map((item) => item.role), ["system", "assistant", "tool", "tool", "user"]);
  assert.equal(typeof request[2].content, "string");
  assert.equal(typeof request[3].content, "string");
  assert.equal((request[4].content as unknown[]).length, 4);
});

test("image inputs require a resolver and respect declared model modalities and cancellation", async () => {
  const messages: ModelMessage[] = [{ role: "user", content: "", attachments: [attachment] }];
  await assert.rejects(() => prepareAttachmentImages(messages, {}), /storage is unavailable/);
  await assert.rejects(() => prepareAttachmentImages(messages, { inputModalities: ["text"] }), /text only/);
  await assert.rejects(() => prepareAttachmentImages(messages, {}, AbortSignal.abort()), /cancelled/);
  const result = await prepareAttachmentImages(messages, { resolveAttachmentImages: async () => [image] });
  assert.deepEqual(result.get(attachmentImageKey(attachment)), [image]);
});

test("reusing an attachment with distinct image selections keeps each message snapshot intact", async () => {
  const other = { ...attachment, imageLabels: ["Page 2"] };
  const messages: ModelMessage[] = [
    { role: "user", content: "earlier", attachments: [attachment] },
    { role: "user", content: "current", attachments: [other] },
    { role: "user", content: "text reference", attachments: [{ ...attachment, imageLabels: [] }] },
  ];
  const prepared = await prepareAttachmentImages(messages, { resolveAttachmentImages: async (item) => [{ ...image, dataUrl: `data:image/jpeg;base64,${item.imageLabels[0] === "Page 1" ? "AA==" : "AQ=="}` }] });
  assert.equal(prepared.size, 2);
  const wire = toOpenAIMessages(messages, "system", undefined, prepared);
  assert.match(JSON.stringify(wire[1]), /base64,AA==/);
  assert.match(JSON.stringify(wire[2]), /base64,AQ==/);
  assert.doesNotMatch(JSON.stringify(wire[3]), /image_url/);
});

test("an image-only submission reaches the first model request with actual image content", async (t) => {
  let received: { messages: Array<{ role: string; content: unknown }> } | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end('data: {"choices":[{"delta":{"content":"Seen"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  for await (const _ of streamOpenAI([{ role: "user", content: "", attachments: [attachment] }], [], { apiKey: "fixture", baseURL: `http://127.0.0.1:${address.port}/v1`, resolveAttachmentImages: async () => [image] })) { /* Consume the first response. */ }
  assert.equal(received?.messages.length, 2);
  assert.match(JSON.stringify(received?.messages[1]), /data:image\/jpeg;base64,AA==/);
});

test("Runtime commits an attachment-only user entry and projects it into the first turn", async (t) => {
  const recorder = await createTransientHistoryRecorder();
  t.after(async () => { await recorder.close(); await recorder.repository.close?.(); });
  const requests: ModelMessage[][] = [];
  const result = await run("", { provider: "openai", model: "fixture" }, {
    runId: "attachment-only", cwd: tmpdir(), systemPrompt: "fixture", tools: new Map(), recorder,
    initialAttachments: [attachment],
    responseImpl: async function* (_config, messages) {
      requests.push(messages);
      yield { type: "completed", content: "The image is visible.", toolCalls: [], stopReason: "stop" };
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0].content, "");
  assert.deepEqual(requests[0][0].attachments, [attachment]);
  const entries = await recorder.repository.listEntries(null, 0, 10);
  assert.equal(entries[0].payload.content, "");
  assert.deepEqual(entries[0].payload.attachments, [attachment]);
  assert.equal(JSON.stringify(entries[0].payload).includes("base64"), false);
});
