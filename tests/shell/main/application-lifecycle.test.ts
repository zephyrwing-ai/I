import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ApplicationLifecycle, installApplicationLifecycle, registerWindowResources } from "../../../shell/main/application-lifecycle.js";
import { QuitPreparation } from "../../../shell/main/quit-preparation.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("shutdown drains admitted operations, rejects new work and closes the shared database exactly once", async () => {
  const work = deferred();
  const calls: string[] = [];
  const lifecycle = new ApplicationLifecycle({
    prepare: async () => { calls.push("prepare"); await lifecycle.waitForRequests(); },
    drain: async () => { calls.push("drain"); },
    close: () => { calls.push("close"); },
    exit: (code) => { calls.push(`exit:${code}`); },
    onError: (error) => assert.fail(String(error)),
  });
  const admitted = lifecycle.admit(async () => { await work.promise; calls.push("write"); });
  const quitting = lifecycle.requestQuit();
  assert.equal(lifecycle.requestQuit(), quitting);
  assert.equal(lifecycle.phase, "draining");
  await assert.rejects(lifecycle.admit(() => calls.push("late")), /preparing to quit/);
  await lifecycle.admit(() => calls.push("canvas-save"), true);
  work.resolve();
  await admitted;
  await quitting;
  assert.deepEqual(calls, ["prepare", "canvas-save", "write", "drain", "close", "exit:0"]);
  await lifecycle.requestQuit();
  await assert.rejects(lifecycle.admit(() => undefined, true), /preparing to quit/);
  assert.equal(calls.filter((call) => call === "close").length, 1);
});

test("failed renderer preparation preserves usable services and permits a later quit retry", async () => {
  let attempts = 0;
  let closes = 0;
  let drains = 0;
  const errors: unknown[] = [];
  const lifecycle = new ApplicationLifecycle({
    prepare: () => { if (++attempts === 1) throw new Error("Canvas save conflict"); return Promise.resolve(); },
    drain: async () => { drains += 1; },
    close: () => { closes += 1; },
    exit: () => undefined,
    onError: (error) => errors.push(error),
  });
  await lifecycle.requestQuit();
  assert.equal(lifecycle.phase, "running");
  assert.equal(await lifecycle.admit(() => "query succeeds"), "query succeeds");
  assert.equal(drains, 0);
  assert.equal(closes, 0);
  assert.equal(errors.length, 1);
  await lifecycle.requestQuit();
  assert.equal(drains, 1);
  assert.equal(closes, 1);
});

test("committed teardown failures still close storage and terminate with a failure status", async () => {
  const calls: string[] = [];
  const lifecycle = new ApplicationLifecycle({
    prepare: async () => undefined,
    drain: async () => { throw new Error("write failed"); },
    close: () => { calls.push("close"); throw new Error("close failed"); },
    exit: (code) => { calls.push(`exit:${code}`); },
    onError: () => undefined,
  });
  await lifecycle.requestQuit();
  assert.deepEqual(calls, ["close", "exit:1"]);
  assert.equal(lifecycle.phase, "terminating");
});

test("macOS window close preserves services, activation reopens only while running, and repeated signals share shutdown", async () => {
  const application = new EventEmitter();
  const signals = new EventEmitter();
  const prepare = deferred();
  let opened = 0;
  let closed = 0;
  const lifecycle = new ApplicationLifecycle({
    prepare: () => prepare.promise, drain: async () => undefined,
    close: () => { closed += 1; }, exit: () => undefined, onError: (error) => assert.fail(String(error)),
  });
  installApplicationLifecycle(application, signals, lifecycle, {
    hasOpenWindows: () => false, create: () => { opened += 1; }, platform: "darwin",
  });
  application.emit("window-all-closed");
  assert.equal(lifecycle.phase, "running");
  application.emit("activate");
  assert.equal(opened, 1);
  let prevented = 0;
  application.emit("before-quit", { preventDefault: () => { prevented += 1; } });
  application.emit("before-quit", { preventDefault: () => { prevented += 1; } });
  signals.emit("SIGTERM");
  signals.emit("SIGINT");
  application.emit("activate");
  assert.equal(opened, 1);
  assert.equal(prevented, 2);
  prepare.resolve();
  await lifecycle.requestQuit();
  assert.equal(closed, 1);
});

test("renderer quit acknowledgments bind both the owner and request identity", async () => {
  const preparation = new QuitPreparation();
  preparation.setReady(4, true);
  let requestId = "";
  const flush = preparation.flush([{ id: 4, send: (id) => { requestId = id; } }]);
  assert.equal(preparation.isWaiting(4), true);
  preparation.complete(9, { requestId });
  preparation.complete(4, { requestId: "stale" });
  assert.equal(preparation.isWaiting(4), true);
  preparation.complete(4, { requestId });
  await flush;
  assert.equal(preparation.isWaiting(4), false);
});

test("renderer save errors and timeouts clear preparation state for a retry", async () => {
  const preparation = new QuitPreparation(15);
  preparation.setReady(4, true);
  const failed = preparation.flush([{ id: 4, send: (requestId) => preparation.complete(4, { requestId, error: "conflict" }) }]);
  await assert.rejects(failed, /conflict/);
  assert.equal(preparation.isWaiting(4), false);
  await assert.rejects(preparation.flush([{ id: 4, send: () => undefined }]), /acknowledge/);
  const retry = preparation.flush([{ id: 4, send: () => preparation.removeOwner(4) }]);
  await retry;
  assert.equal(preparation.isWaiting(4), false);
});

function destroyableWindow(ownerId: number) {
  const events = new EventEmitter();
  let destroyed = false;
  const webContents = {
    get id(): number {
      if (destroyed) throw new Error("Object has been destroyed");
      return ownerId;
    },
    once(event: "destroyed", listener: () => void): unknown {
      return events.once(event, listener);
    },
  };
  return {
    window: {
      get webContents() {
        if (destroyed) throw new Error("Object has been destroyed");
        return webContents;
      },
    },
    webContents,
    destroy(): void {
      destroyed = true;
      events.emit("destroyed");
    },
  };
}

test("destroyed window resources are released once after native getters become unusable", async (t) => {
  const owner = destroyableWindow(4);
  const voicePermissionOwners = new Set<number>();
  const preparation = new QuitPreparation(1_000);
  const removeOwner = t.mock.method(preparation, "removeOwner");
  const cancelledOwners: number[] = [];

  assert.equal(owner.window.webContents, owner.webContents);
  assert.equal(owner.webContents.id, 4);
  registerWindowResources(owner.window, {
    voicePermissionOwners,
    quitPreparation: preparation,
    voiceTranscription: { cancelOwner: (ownerId) => { cancelledOwners.push(ownerId); } },
  });
  assert.deepEqual([...voicePermissionOwners], [4]);

  preparation.setReady(4, true);
  const requests: string[] = [];
  const flush = preparation.flush([{ id: 4, send: (requestId) => { requests.push(requestId); } }]);
  assert.equal(requests.length, 1);
  assert.equal(preparation.isWaiting(4), true);

  assert.doesNotThrow(() => owner.destroy());
  assert.throws(() => owner.webContents.id, /Object has been destroyed/);
  assert.throws(() => owner.window.webContents, /Object has been destroyed/);
  assert.doesNotThrow(() => owner.destroy());
  assert.equal(preparation.isWaiting(4), false);
  await flush;

  assert.deepEqual([...voicePermissionOwners], []);
  assert.deepEqual(removeOwner.mock.calls.map((call) => call.arguments[0]), [4]);
  assert.deepEqual(cancelledOwners, [4]);
  await preparation.flush([{ id: 4, send: () => assert.fail("Destroyed owner retained its ready registration") }]);
});

test("window resource cleanup preserves other owners and permits a newly opened window", async (t) => {
  const closed = destroyableWindow(4);
  const surviving = destroyableWindow(9);
  const reopened = destroyableWindow(12);
  const voicePermissionOwners = new Set<number>();
  const preparation = new QuitPreparation(1_000);
  const removeOwner = t.mock.method(preparation, "removeOwner");
  const cancelledOwners: number[] = [];
  const resources = {
    voicePermissionOwners,
    quitPreparation: preparation,
    voiceTranscription: { cancelOwner: (ownerId: number) => { cancelledOwners.push(ownerId); } },
  };

  registerWindowResources(closed.window, resources);
  registerWindowResources(surviving.window, resources);
  assert.deepEqual([...voicePermissionOwners], [4, 9]);
  preparation.setReady(4, true);
  preparation.setReady(9, true);
  let survivingRequestId = "";
  const closedFlush = preparation.flush([{ id: 4, send: () => undefined }]);
  const survivingFlush = preparation.flush([{ id: 9, send: (requestId) => { survivingRequestId = requestId; } }]);
  assert.equal(preparation.isWaiting(4), true);
  assert.equal(preparation.isWaiting(9), true);

  assert.doesNotThrow(() => closed.destroy());
  await closedFlush;
  assert.deepEqual([...voicePermissionOwners], [9]);
  assert.equal(preparation.isWaiting(4), false);
  assert.equal(preparation.isWaiting(9), true);
  assert.deepEqual(removeOwner.mock.calls.map((call) => call.arguments[0]), [4]);
  assert.deepEqual(cancelledOwners, [4]);

  registerWindowResources(reopened.window, resources);
  assert.equal(reopened.window.webContents.id, 12);
  assert.deepEqual([...voicePermissionOwners], [9, 12]);
  preparation.setReady(12, true);
  let reopenedRequestId = "";
  const reopenedFlush = preparation.flush([{ id: 12, send: (requestId) => { reopenedRequestId = requestId; } }]);
  assert.equal(preparation.isWaiting(12), true);
  assert.doesNotThrow(() => closed.destroy());
  assert.deepEqual([...voicePermissionOwners], [9, 12]);
  assert.equal(preparation.isWaiting(9), true);
  assert.equal(preparation.isWaiting(12), true);
  assert.deepEqual(removeOwner.mock.calls.map((call) => call.arguments[0]), [4]);
  assert.deepEqual(cancelledOwners, [4]);

  preparation.complete(9, { requestId: survivingRequestId });
  await survivingFlush;
  assert.equal(preparation.isWaiting(9), false);
  assert.equal(preparation.isWaiting(12), true);
  preparation.complete(12, { requestId: reopenedRequestId });
  await reopenedFlush;
  assert.equal(preparation.isWaiting(12), false);

  assert.doesNotThrow(() => surviving.destroy());
  assert.doesNotThrow(() => reopened.destroy());
  assert.deepEqual([...voicePermissionOwners], []);
  assert.deepEqual(removeOwner.mock.calls.map((call) => call.arguments[0]), [4, 9, 12]);
  assert.deepEqual(cancelledOwners, [4, 9, 12]);
});
