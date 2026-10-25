import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectDescriptor } from "../../../../../shell/shared/ipc.js";
import {
  createProjectListController,
  type ProjectListState,
} from "../../../../../frontend/src/workbench/project/projectListController.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function project(id: string, pinned = false): ProjectDescriptor {
  return { projectId: id, displayName: id, canonicalPath: `/projects/${id}`, pinned };
}

function harness() {
  const states: ProjectListState[] = [];
  const requests: Array<ReturnType<typeof deferred<ProjectDescriptor[]>>> = [];
  const controller = createProjectListController({
    listProjects: () => {
      const response = deferred<ProjectDescriptor[]>();
      requests.push(response);
      return response.promise;
    },
  }, (state) => states.push(state));
  return { controller, requests, states, latest: () => states.at(-1)! };
}

test("awaiting a shared read returns the exact ordered UI snapshot and caches it", async () => {
  const { controller, requests, states, latest } = harness();
  const first = controller.ensureLoaded();
  assert.equal(controller.ensureLoaded(), first);
  assert.equal(latest().loading, true);
  await Promise.resolve();
  assert.equal(requests.length, 1);

  const ordered = [project("zeta"), project("alpha", true)];
  requests[0].resolve(ordered);
  const snapshot = await first;
  assert.equal(snapshot, ordered);
  assert.equal(snapshot, latest().projects);
  assert.equal(snapshot?.[0].projectId, "zeta");
  assert.deepEqual(latest(), { projects: ordered, loaded: true, loading: false, error: null });

  const publicationCount = states.length;
  assert.equal(await controller.ensureLoaded(), snapshot);
  assert.equal(requests.length, 1);
  assert.equal(states.length, publicationCount);
});

test("a successfully loaded empty list is a cached snapshot", async () => {
  const { controller, requests, latest } = harness();
  const read = controller.ensureLoaded();
  await Promise.resolve();
  const empty: ProjectDescriptor[] = [];
  requests[0].resolve(empty);

  assert.equal(await read, empty);
  assert.equal(await controller.ensureLoaded(), empty);
  assert.equal(latest().loaded, true);
  assert.equal(requests.length, 1);
});

test("ensureLoaded joins an active refresh before returning a previously loaded cache", async () => {
  const { controller, requests, latest } = harness();
  const previous = [project("previous")];
  controller.replace(previous);
  const refresh = controller.refresh();
  assert.equal(controller.ensureLoaded(), refresh);
  assert.equal(latest().projects, previous);
  assert.equal(latest().loading, true);
  await Promise.resolve();

  const updated = [project("updated"), project("previous")];
  requests[0].resolve(updated);
  assert.equal(await refresh, updated);
  assert.equal(await controller.ensureLoaded(), updated);
  assert.equal(latest().projects, updated);
  assert.equal(requests.length, 1);
});

for (const outcome of ["success", "failure"] as const) {
  test(`replace synchronizes the cache immediately and invalidates a pending ${outcome}`, async () => {
    const { controller, requests, states, latest } = harness();
    const read = controller.ensureLoaded();
    await Promise.resolve();

    const replacement = [project("replacement")];
    controller.replace(replacement);
    // Capture the read in the same turn, before React could render the replacement.
    const cached = controller.ensureLoaded();
    const committed = latest();
    const publicationCount = states.length;
    assert.equal(await cached, replacement);
    assert.equal(requests.length, 1);

    if (outcome === "success") requests[0].resolve([project("removed")]);
    else requests[0].reject(new Error("outdated request"));
    assert.equal(await read, null);
    assert.equal(latest(), committed);
    assert.equal(states.length, publicationCount);
    assert.equal(await controller.ensureLoaded(), replacement);
  });
}

test("replace with an empty list invalidates a read before its IPC call starts", async () => {
  const { controller, requests, latest } = harness();
  const read = controller.ensureLoaded();
  const empty: ProjectDescriptor[] = [];
  controller.replace(empty);
  const cached = controller.ensureLoaded();
  assert.equal(await cached, empty);
  assert.equal(requests.length, 1);

  requests[0].resolve([project("stale")]);
  assert.equal(await read, null);
  assert.equal(latest().projects, empty);
  assert.equal(latest().loaded, true);
  assert.equal(latest().loading, false);
});

for (const outcome of ["success", "failure"] as const) {
  test(`a superseded refresh ${outcome} preserves the newer request and its waiters`, async () => {
    const { controller, requests, latest } = harness();
    const first = controller.refresh();
    const second = controller.refresh();
    assert.notEqual(first, second);
    await Promise.resolve();
    assert.equal(requests.length, 2);

    if (outcome === "success") requests[0].resolve([project("old")]);
    else requests[0].reject(new Error("old failure"));
    assert.equal(await first, null);
    assert.equal(latest().loading, true);
    assert.equal(latest().loaded, false);
    assert.equal(latest().error, null);
    assert.equal(controller.ensureLoaded(), second);

    const updated = [project("new")];
    requests[1].resolve(updated);
    assert.equal(await second, updated);
    assert.equal(await controller.ensureLoaded(), updated);
    assert.equal(requests.length, 2);
  });
}

test("an older read completing after the newest refresh returns null and leaves its UI snapshot intact", async () => {
  const { controller, requests, states, latest } = harness();
  const oldRead = controller.ensureLoaded();
  const refresh = controller.refresh();
  await Promise.resolve();
  const updated = [project("new")];
  requests[1].resolve(updated);
  assert.equal(await refresh, updated);
  const committed = latest();
  const publicationCount = states.length;

  requests[0].resolve([project("old")]);
  assert.equal(await oldRead, null);
  assert.equal(latest(), committed);
  assert.equal(states.length, publicationCount);
  assert.equal(await controller.ensureLoaded(), updated);
});

test("an initial failure returns null, publishes an error, and permits ensureLoaded to retry", async () => {
  const { controller, requests, latest } = harness();
  const read = controller.ensureLoaded();
  await Promise.resolve();
  requests[0].reject(new Error("IPC unavailable"));
  assert.equal(await read, null);
  assert.deepEqual(latest(), { projects: [], loaded: false, loading: false, error: "IPC unavailable" });

  const retry = controller.ensureLoaded();
  assert.equal(latest().loading, true);
  assert.equal(latest().error, null);
  await Promise.resolve();
  const recovered = [project("recovered")];
  requests[1].resolve(recovered);
  assert.equal(await retry, recovered);
  assert.equal(latest().projects, recovered);
});

test("a refresh failure preserves the loaded cache and error until the next refresh", async () => {
  const { controller, requests, latest } = harness();
  const previous = [project("previous")];
  controller.replace(previous);
  const refresh = controller.refresh();
  await Promise.resolve();
  requests[0].reject("disk unavailable");
  assert.equal(await refresh, null);
  assert.deepEqual(latest(), { projects: previous, loaded: true, loading: false, error: "disk unavailable" });
  assert.equal(await controller.ensureLoaded(), previous);
  assert.equal(latest().error, "disk unavailable");
  assert.equal(requests.length, 1);

  const retry = controller.refresh();
  assert.equal(latest().error, null);
  assert.equal(latest().projects, previous);
  await Promise.resolve();
  const updated = [project("updated")];
  requests[1].resolve(updated);
  assert.equal(await retry, updated);
  assert.equal(latest().projects, updated);
});

test("a synchronous API failure resolves to null and remains retryable", async () => {
  let attempts = 0;
  const states: ProjectListState[] = [];
  const recovered = [project("recovered")];
  const controller = createProjectListController({
    listProjects: () => {
      if (++attempts === 1) throw new Error("bridge unavailable");
      return Promise.resolve(recovered);
    },
  }, (state) => states.push(state));

  assert.equal(await controller.ensureLoaded(), null);
  assert.equal(states.at(-1)?.error, "bridge unavailable");
  assert.equal(await controller.ensureLoaded(), recovered);
  assert.equal(states.at(-1)?.projects, recovered);
  assert.equal(attempts, 2);
});
