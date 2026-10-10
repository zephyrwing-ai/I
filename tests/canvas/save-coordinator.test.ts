import assert from "node:assert/strict";
import test from "node:test";
import {
  CanvasSaveConflictError,
  CanvasSaveCoordinator,
  type CanvasSaveState,
} from "../../canvas/persistence/CanvasSaveCoordinator.js";
import type {
  CanvasDocument,
  CanvasPersistenceVersion,
  CanvasSaveRequest,
  CanvasSaveResult,
} from "../../shell/shared/ipc.js";

function document(value: number): CanvasDocument {
  return { elements: [{ id: "rectangle-1", x: value }], appState: { scrollX: value }, files: {} };
}

function version(revision: number): CanvasPersistenceVersion {
  return { revision, fingerprint: `scene-${revision}` };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function setup(projectId: string | null = "project-1") {
  const requests: CanvasSaveRequest[] = [];
  const responses: ReturnType<typeof deferred<CanvasSaveResult>>[] = [];
  const states: CanvasSaveState[] = [];
  const coordinator = new CanvasSaveCoordinator({
    projectId,
    initial: { document: document(0), version: version(1) },
    debounceMs: 5,
    save: (request) => {
      requests.push(request);
      const response = deferred<CanvasSaveResult>();
      responses.push(response);
      return response.promise;
    },
    onStateChange: (state) => states.push(state),
  });
  return { coordinator, requests, responses, states };
}

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const timerTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 12));

test("multiple flush callers share the active save and its acknowledgement", async () => {
  const { coordinator, requests, responses } = setup();
  coordinator.update(document(1));
  const first = coordinator.flush();
  const second = coordinator.flush();
  assert.equal(requests.length, 1);
  responses[0].resolve({ status: "saved", version: version(2) });
  await Promise.all([first, second]);
  assert.equal(requests.length, 1);
  assert.deepEqual(coordinator.state, { phase: "clean", dirty: false, error: null });
  coordinator.dispose();
});

test("pending edits coalesce into the latest snapshot and advance the persistence base", async () => {
  const { coordinator, requests, responses, states } = setup();
  coordinator.update(document(1));
  const first = coordinator.flush();
  coordinator.update(document(2));
  const second = coordinator.flush();
  coordinator.update(document(3));
  assert.equal(requests.length, 1);
  responses[0].resolve({ status: "saved", version: version(2) });
  await first;
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].document, document(3));
  assert.deepEqual(requests[1].expectedVersion, version(2));
  assert.equal(coordinator.state.dirty, true, "an older acknowledgement leaves the newer draft dirty");
  assert.equal(states.some((state) => state.phase === "clean"), false);
  responses[1].resolve({ status: "saved", version: version(3) });
  await second;
  coordinator.update(document(4));
  const third = coordinator.flush();
  assert.deepEqual(requests[2].expectedVersion, version(3));
  responses[2].resolve({ status: "saved", version: version(4) });
  await third;
  assert.equal(coordinator.state.dirty, false);
  coordinator.dispose();
});

test("submission captures an immutable snapshot while retaining the latest editor reference", async () => {
  const { coordinator, requests, responses } = setup();
  const mutableDraft = document(1);
  coordinator.update(mutableDraft);
  const flush = coordinator.flush();
  mutableDraft.elements[0].x = 2;
  mutableDraft.appState.scrollX = 2;
  coordinator.update(mutableDraft);
  assert.equal(coordinator.document, mutableDraft);
  assert.deepEqual(requests[0].document, document(1));
  responses[0].resolve({ status: "saved", version: version(2) });
  await flush;
  assert.deepEqual(requests[1].document, document(2));
  responses[1].resolve({ status: "saved", version: version(3) });
  await nextTurn();
  coordinator.dispose();
});

test("debounced updates write one latest snapshot and deduplicate unchanged state notifications", async () => {
  const { coordinator, requests, responses, states } = setup();
  coordinator.update(document(1));
  coordinator.update(document(2));
  coordinator.update(document(3));
  assert.equal(states.length, 1);
  await timerTurn();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].document, document(3));
  const flush = coordinator.flush();
  responses[0].resolve({ status: "saved", version: version(2) });
  await flush;
  assert.deepEqual(states.map((state) => state.phase), ["scheduled", "saving", "clean"]);
  coordinator.dispose();
});

test("a failed save preserves the latest draft and explicit flush retries from the acknowledged base", async () => {
  const { coordinator, requests, responses } = setup();
  coordinator.update(document(1));
  const first = coordinator.flush();
  const failure = assert.rejects(first, /disk full/);
  coordinator.update(document(2));
  responses[0].reject(new Error("disk full"));
  await failure;
  assert.deepEqual(coordinator.document, document(2));
  assert.deepEqual(coordinator.state, { phase: "error", dirty: true, error: "disk full" });
  coordinator.update(document(3));
  await timerTurn();
  assert.equal(requests.length, 1, "a failed save waits for an explicit retry");
  const retry = coordinator.flush();
  assert.deepEqual(requests[1].document, document(3));
  assert.deepEqual(requests[1].expectedVersion, version(1));
  responses[1].resolve({ status: "saved", version: version(2) });
  await retry;
  assert.equal(coordinator.state.phase, "clean");
  coordinator.dispose();
});

test("disk conflicts preserve new drafts and suspend subsequent save attempts", async () => {
  const { coordinator, requests, responses } = setup();
  coordinator.update(document(1));
  const flush = coordinator.flush();
  const conflict = assert.rejects(flush, (error: unknown) => {
    assert.ok(error instanceof CanvasSaveConflictError);
    assert.deepEqual(error.version, version(9));
    return true;
  });
  responses[0].resolve({ status: "conflict", version: version(9) });
  await conflict;
  coordinator.update(document(2));
  await timerTurn();
  assert.equal(coordinator.state.phase, "conflict");
  assert.equal(coordinator.state.dirty, true);
  assert.deepEqual(coordinator.document, document(2));
  await assert.rejects(coordinator.flush(), CanvasSaveConflictError);
  assert.equal(requests.length, 1);
  coordinator.dispose();
});

test("disposing cancels timers and allows only the captured active snapshot to settle", async () => {
  const retired = setup("retired-project");
  retired.coordinator.update(document(1));
  const active = retired.coordinator.flush();
  retired.coordinator.update(document(2));
  const pending = retired.coordinator.flush();
  const disposed = assert.rejects(pending, /disposed/);
  retired.coordinator.dispose();
  await disposed;
  retired.responses[0].resolve({ status: "saved", version: version(2) });
  await active;
  await timerTurn();
  assert.equal(retired.requests.length, 1);
  assert.equal(retired.requests[0].projectId, "retired-project");
  assert.equal(retired.coordinator.state.dirty, true);
  assert.equal(retired.states.filter((state) => state.phase === "clean").length, 0);

  const current = setup("current-project");
  current.coordinator.update(document(3));
  const flush = current.coordinator.flush();
  assert.equal(current.requests[0].projectId, "current-project");
  current.responses[0].resolve({ status: "saved", version: version(2) });
  await flush;
  current.coordinator.update(document(4));
  current.coordinator.dispose();
  await timerTurn();
  assert.equal(current.requests.length, 1);
});

test("flush before disposal drains the retiring scope's newest pending draft", async () => {
  const { coordinator, requests, responses } = setup(null);
  coordinator.update(document(1));
  const first = coordinator.flush();
  coordinator.update(document(2));
  const retirement = coordinator.flush().finally(() => coordinator.dispose());
  responses[0].resolve({ status: "saved", version: version(2) });
  await first;
  assert.equal(requests.length, 2);
  assert.equal(requests[1].projectId, null);
  assert.deepEqual(requests[1].document, document(2));
  responses[1].resolve({ status: "saved", version: version(3) });
  await retirement;
  assert.equal(coordinator.state.dirty, false);
});
