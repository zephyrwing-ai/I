import assert from "node:assert/strict";
import test from "node:test";
import type { OpenOutputFileResult, OutputFilePreviewResult } from "../../../../shell/shared/ipc.js";
import {
  createOutputFilePreviewController,
  type OutputFileIdentity,
  type OutputFilePreviewState,
} from "../../../../frontend/src/store/outputFilePreview.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function target(patch: Partial<OutputFileIdentity> = {}): OutputFileIdentity {
  return { runId: "run-first", fileId: "file-first", updatedAt: "2026-09-08T08:00:00.000Z", ...patch };
}

function preview(content: string): OutputFilePreviewResult {
  return {
    ok: true, kind: "text", mediaType: "text/plain", content,
    truncated: false, byteSize: content.length, updatedAt: "2026-09-08T08:00:00.000Z",
  };
}

function harness() {
  const states: OutputFilePreviewState[] = [];
  const previews: Array<{ runId: string; fileId: string; response: ReturnType<typeof deferred<OutputFilePreviewResult>> }> = [];
  const opens: Array<{ runId: string; fileId: string; response: ReturnType<typeof deferred<OpenOutputFileResult>> }> = [];
  const controller = createOutputFilePreviewController({
    previewOutputFile: (runId, fileId) => {
      const response = deferred<OutputFilePreviewResult>();
      previews.push({ runId, fileId, response });
      return response.promise;
    },
    openOutputFile: (runId, fileId) => {
      const response = deferred<OpenOutputFileResult>();
      opens.push({ runId, fileId, response });
      return response.promise;
    },
  }, (state) => states.push(state));
  return { controller, previews, opens, states, latest: () => states.at(-1)! };
}

test("selecting B keeps its loading state when the preceding A preview arrives", async () => {
  const { controller, previews, latest } = harness();
  const first = controller.select(target());
  const second = controller.select(target({ fileId: "file-second" }));

  previews[0].response.resolve(preview("A"));
  await first;
  assert.equal(latest().loading, true);
  assert.equal(latest().preview, null);
  assert.equal(latest().target?.fileId, "file-second");

  previews[1].response.resolve(preview("B"));
  await second;
  assert.deepEqual(latest().preview, preview("B"));
  assert.equal(latest().loading, false);
});

test("a late failure from A cannot replace the completed B preview", async () => {
  const { controller, previews, latest } = harness();
  const first = controller.select(target());
  const second = controller.select(target({ fileId: "file-second" }));
  previews[1].response.resolve(preview("B"));
  await second;
  previews[0].response.reject(new Error("A cannot be read"));
  await first;

  assert.deepEqual(latest().preview, preview("B"));
  assert.equal(latest().loading, false);
});

test("the newest refresh wins even when all file identity fields remain equal", async () => {
  const { controller, previews, latest } = harness();
  const first = controller.select(target());
  const second = controller.refresh();
  previews[1].response.resolve(preview("fresh contents"));
  await second;
  previews[0].response.resolve(preview("stale contents"));
  await first;

  assert.deepEqual(latest().preview, preview("fresh contents"));
  assert.equal(latest().loading, false);
});

test("updating the selected file clears the preceding revision until its new preview arrives", async () => {
  const { controller, previews, latest } = harness();
  const initial = controller.select(target());
  previews[0].response.resolve(preview("old revision"));
  await initial;
  const oldRefresh = controller.refresh();
  const updated = controller.select(target({ updatedAt: "2026-09-08T08:00:01.000Z" }));
  assert.equal(latest().preview, null);

  previews[1].response.resolve(preview("old refresh"));
  await oldRefresh;
  assert.equal(latest().loading, true);
  assert.equal(latest().preview, null);
  previews[2].response.resolve(preview("updated revision"));
  await updated;
  assert.deepEqual(latest().preview, preview("updated revision"));
  assert.equal(latest().target?.updatedAt, "2026-09-08T08:00:01.000Z");
});

test("switching runs invalidates a preview even with the same file ID and timestamp", async () => {
  const { controller, previews, latest } = harness();
  const first = controller.select(target());
  const second = controller.select(target({ runId: "run-second" }));
  assert.equal(previews[1].runId, "run-second");
  previews[1].response.resolve(preview("new run"));
  await second;
  previews[0].response.resolve(preview("old run"));
  await first;

  assert.equal(latest().target?.runId, "run-second");
  assert.deepEqual(latest().preview, preview("new run"));
});

test("an empty file list clears loading, preview, and errors while pending responses are ignored", async () => {
  const { controller, previews, opens, latest } = harness();
  const reading = controller.select(target());
  const opening = controller.open();
  await controller.select(null);
  previews[0].response.reject(new Error("removed file"));
  opens[0].response.resolve({ ok: false, error: "removed file" });
  await Promise.all([reading, opening]);

  assert.deepEqual(latest(), { target: null, preview: null, loading: false, openError: null });
});

test("unmount invalidation prevents both pending file operations from publishing state", async () => {
  const { controller, previews, opens, states } = harness();
  const reading = controller.select(target());
  const opening = controller.open();
  const publicationsBeforeUnmount = states.length;
  controller.invalidate();
  previews[0].response.resolve(preview("finished after unmount"));
  opens[0].response.reject(new Error("failed after unmount"));
  await Promise.all([reading, opening]);

  assert.equal(states.length, publicationsBeforeUnmount);
});

test("a current IPC rejection ends loading and displays a recoverable preview error", async () => {
  const { controller, previews, latest } = harness();
  const reading = controller.select(target());
  previews[0].response.reject(new Error("IPC connection lost"));
  await reading;
  assert.deepEqual(latest().preview, { ok: false, error: "read_failed", message: "IPC connection lost" });
  assert.equal(latest().loading, false);

  const retry = controller.refresh();
  assert.equal(latest().preview, null);
  assert.equal(latest().loading, true);
  previews[1].response.resolve(preview("retry succeeded"));
  await retry;
  assert.deepEqual(latest().preview, preview("retry succeeded"));
});

test("open failures belong only to the latest open operation for the current file", async () => {
  const { controller, previews, opens, latest } = harness();
  const reading = controller.select(target());
  previews[0].response.resolve(preview("A"));
  await reading;
  const firstOpen = controller.open();
  const secondOpen = controller.open();
  opens[1].response.resolve({ ok: true });
  await secondOpen;
  opens[0].response.reject(new Error("old failure"));
  await firstOpen;
  assert.equal(latest().openError, null);

  const currentOpen = controller.open();
  opens[2].response.reject(new Error("current failure"));
  await currentOpen;
  assert.equal(latest().openError, "current failure");
});

test("selecting another file or refreshing prevents a preceding open error from reappearing", async () => {
  const { controller, previews, opens, latest } = harness();
  const initial = controller.select(target());
  previews[0].response.resolve(preview("A"));
  await initial;
  const oldOpen = controller.open();
  const nextFile = controller.select(target({ fileId: "file-second" }));
  previews[1].response.resolve(preview("B"));
  await nextFile;
  opens[0].response.resolve({ ok: false, error: "old file failure" });
  await oldOpen;
  assert.equal(latest().openError, null);

  const oldRefreshOpen = controller.open();
  const refreshed = controller.refresh();
  previews[2].response.resolve(preview("B refreshed"));
  await refreshed;
  opens[1].response.resolve({ ok: false, error: "failure before refresh" });
  await oldRefreshOpen;
  assert.equal(latest().openError, null);
  assert.deepEqual(latest().preview, preview("B refreshed"));
});
