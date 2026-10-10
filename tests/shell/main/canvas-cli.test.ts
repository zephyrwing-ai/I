import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "vite";
import { CanvasCliExecutor } from "../../../shell/main/canvas-cli-executor.js";
import { CanvasEditBridge, type CanvasEditRequestBody } from "../../../shell/main/canvas-edit-bridge.js";
import type { CanvasEditCancel, CanvasEditRequest, CanvasEditResult } from "../../../canvas/commands/types.js";

const source = fileURLToPath(new URL("../../../canvas/cli/index.ts", import.meta.url));
const sourceOptions = { cliPath: source, execArgv: ["--import", "tsx"], timeoutMs: 5_000 };
const body = (): CanvasEditRequestBody => ({
  runId: "cli-run", projectId: "project-a", sourceElements: [],
  operations: [{ action: "create", element: { type: "text", x: 20, y: 40, text: 'A literal: $(touch ignored); "quoted" 中文' } }],
});
const saved = (request: CanvasEditRequestBody): CanvasEditResult => ({
  requestId: "edit-confirmation", runId: request.runId, projectId: request.projectId,
  ok: true, createdIds: ["created-text"], appliedElements: [{ id: "created-text", type: "text", x: 20, y: 40 }],
});

test("Canvas CLI carries literal operations through the existing bridge and waits for saved confirmation", { timeout: 10_000 }, async () => {
  let sent!: (request: CanvasEditRequest) => void;
  const dispatch = new Promise<CanvasEditRequest>((resolve) => { sent = resolve; });
  let owner = 0;
  const bridge = new CanvasEditBridge({
    sendRequest(id, request) { owner = id; sent(request); return true; },
    sendCancel() {}, onOwnerDestroyed: () => () => undefined,
  });
  const cli = new CanvasCliExecutor((id, request, signal) => bridge.request(id, request, signal), sourceOptions);
  const input = body();
  const original = structuredClone(input);
  let completed = false;
  const pending = cli.execute(42, input).then((result) => { completed = true; return result; });
  try {
    input.projectId = "changed-project";
    const request = await dispatch;
    assert.equal(owner, 42);
    assert.equal(completed, false);
    assert.deepEqual(request.operations, original.operations);
    assert.equal(request.projectId, "project-a");
    assert.equal(bridge.handleResult(99, { ...saved(original), requestId: request.requestId }), false);
    assert.equal(bridge.handleResult(42, { ...saved(original), requestId: request.requestId }), true);
    assert.equal((await pending).ok, true);
    assert.equal(completed, true);
  } finally {
    cli.dispose(); bridge.dispose();
  }
});

test("Canvas CLI preserves editor persistence-conflict results and the nonzero command status", async () => {
  const cli = new CanvasCliExecutor(async (_owner, request) => ({ ...saved(request), ok: false, error: "persistence_conflict" }), sourceOptions);
  try {
    const result = await cli.execute(42, body());
    assert.equal(result.ok, false);
    assert.equal(result.error, "persistence_conflict");
  } finally { cli.dispose(); }
});

test("Canvas CLI transports the result contract instead of editor-internal scene fields", async () => {
  const cli = new CanvasCliExecutor(async (_owner, request) => ({
    ...saved(request), elements: [{ id: "unreferenced-scene-element", text: "editor internal data" }],
  }), sourceOptions);
  try {
    const result = await cli.execute(42, body());
    assert.equal(result.ok, true);
    assert.equal(Object.hasOwn(result, "elements"), false);
    assert.equal(result.appliedElements?.[0].id, "created-text");
  } finally { cli.dispose(); }
});

test("Canvas CLI rejects another command before it reaches the editor", async () => {
  let edits = 0;
  const cli = new CanvasCliExecutor(async (_owner, request) => { edits += 1; return saved(request); }, {
    ...sourceOptions, cliPath: fileURLToPath(new URL("./fixtures/canvas-cli-wrong-command.cjs", import.meta.url)), execArgv: [],
  });
  try {
    await assert.rejects(cli.execute(42, body()), (error: unknown) => {
      assert.equal((error as { code: string }).code, "canvas_unavailable");
      return true;
    });
    assert.equal(edits, 0);
  } finally { cli.dispose(); }
});

test("stopping a dispatched Canvas CLI aborts the bridge and reports an unconfirmed outcome", async () => {
  const controller = new AbortController();
  let sent!: () => void;
  const dispatch = new Promise<void>((resolve) => { sent = resolve; });
  const cancellations: CanvasEditCancel[] = [];
  const bridge = new CanvasEditBridge({
    sendRequest() { sent(); return true; },
    sendCancel(_owner, cancel) { cancellations.push(cancel); }, onOwnerDestroyed: () => () => undefined,
  });
  const cli = new CanvasCliExecutor((id, request, signal) => bridge.request(id, request, signal), sourceOptions);
  try {
    const pending = cli.execute(42, body(), controller.signal);
    const rejected = assert.rejects(pending, (error: unknown) => {
      assert.equal((error as { code: string }).code, "outcome_unknown");
      return true;
    });
    await dispatch;
    controller.abort();
    await rejected;
    assert.equal(cancellations.length, 1);
    assert.equal(cancellations[0].projectId, "project-a");
  } finally { cli.dispose(); bridge.dispose(); }
});

test("Canvas CLI pre-start cancellation and missing entrypoints produce no editor effects", async () => {
  let edits = 0;
  const cli = new CanvasCliExecutor(async (_owner, request) => { edits += 1; return saved(request); }, { ...sourceOptions, cliPath: `${source}.missing` });
  try {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(cli.execute(42, body(), controller.signal), (error: unknown) => {
      assert.equal((error as { code: string }).code, "cancelled"); return true;
    });
    await assert.rejects(cli.execute(42, body()), (error: unknown) => {
      assert.equal((error as { code: string }).code, "canvas_unavailable"); return true;
    });
    assert.equal(edits, 0);
  } finally { cli.dispose(); }
});

test("Canvas CLI catches synchronous host errors instead of escaping the process message handler", async () => {
  const cli = new CanvasCliExecutor(() => { throw new Error("Host rejected the project"); }, sourceOptions);
  try {
    await assert.rejects(cli.execute(42, body()), /Host rejected the project/);
  } finally { cli.dispose(); }
});

test("Canvas CLI rejects replies belonging to another project", async () => {
  const cli = new CanvasCliExecutor(async (_owner, request) => ({ ...saved(request), projectId: "other-project" }), sourceOptions);
  try {
    await assert.rejects(cli.execute(42, body()), (error: unknown) => {
      assert.equal((error as { code: string }).code, "outcome_unknown");
      assert.match((error as Error).message, /another run or project/);
      return true;
    });
  } finally { cli.dispose(); }
});

test("disposing the Canvas CLI executor cancels its invocation and closes future calls", async () => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  let aborted = false;
  const cli = new CanvasCliExecutor(async (_owner, _request, signal) => {
    signal!.addEventListener("abort", () => { aborted = true; }, { once: true });
    entered();
    return new Promise(() => undefined);
  }, sourceOptions);
  const rejected = assert.rejects(cli.execute(42, body()), (error: unknown) => {
    assert.equal((error as { code: string }).code, "outcome_unknown"); return true;
  });
  try {
    await ready;
    cli.dispose();
    await rejected;
    assert.equal(aborted, true);
    await assert.rejects(cli.execute(42, body()), (error: unknown) => {
      assert.equal((error as { code: string }).code, "canvas_unavailable"); return true;
    });
  } finally { cli.dispose(); }
});

test("Canvas CLI timeouts cancel the active command and avoid implicit retries", { timeout: 10_000 }, async () => {
  let edits = 0;
  let aborted = false;
  const cli = new CanvasCliExecutor(async (_owner, _request, signal) => {
    edits += 1;
    signal!.addEventListener("abort", () => { aborted = true; }, { once: true });
    return new Promise(() => undefined);
  }, { ...sourceOptions, timeoutMs: 1_000 });
  try {
    await assert.rejects(cli.execute(42, body()), (error: unknown) => {
      assert.equal((error as { code: string }).code, "outcome_unknown"); return true;
    });
    assert.equal(edits, 1);
    assert.equal(aborted, true);
  } finally { cli.dispose(); }
});

test("the bundled Canvas CLI runs using Electron's Node execution mode", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvas-cli-bundle-"));
  const electron = createRequire(import.meta.url)("electron") as string;
  try {
    await build({
      configFile: false, logLevel: "silent",
      build: { outDir: directory, minify: false, lib: { entry: source, formats: ["es"], fileName: () => "canvas-cli.mjs" } },
    });
    let edits = 0;
    const cli = new CanvasCliExecutor(async (_owner, request) => { edits += 1; return saved(request); }, {
      cliPath: join(directory, "canvas-cli.mjs"), execPath: electron, timeoutMs: 10_000,
    });
    try {
      const result = await cli.execute(42, body());
      assert.equal(result.ok, true);
      assert.equal(edits, 1);
    } finally { cli.dispose(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
