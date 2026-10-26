import assert from "node:assert/strict";
import test from "node:test";
import { EditProtectionError, EditProtectionSession, type AgentEditProtectionContext, type EditProtectionErrorCode, type EditProtectionState } from "../../canvas/engine/editor/commands/EditProtectionSession.js";
import { expandHumanEditFootprint, getCanvasEditFootprint } from "../../canvas/engine/editor/commands/operationFootprint.js";
import { canvasEditValuesEqual, reconcileCanvasEditElements } from "../../canvas/engine/editor/commands/reconcileCanvasEdit.js";
import { getActionHumanEditTargets } from "../../canvas/engine/editor/actions/editProtection.js";
import { History } from "../../canvas/engine/editor/history.js";
import type { CanvasEditorElement, SceneElementsMap } from "../../canvas/engine/editor/element/types.js";
import type { AppStateChange, ElementsChange } from "../../canvas/engine/editor/change.js";
import type { Snapshot } from "../../canvas/engine/editor/store.js";
import type { AppState } from "../../canvas/engine/editor/types.js";

// Lease lifecycle and human gestures
{
  const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

  function setup() {
    let epoch = 1;
    const states: (EditProtectionState | null)[] = [];
    const session = new EditProtectionSession({
      getEpoch: () => epoch,
      onChange: (state) => states.push(state),
    });
    return { session, states, nextEpoch: () => ++epoch };
  }

  function request<T>(
    apply: (context: AgentEditProtectionContext) => T,
    overrides: Partial<{
      requestId: string;
      epoch: number;
      deadlineAt: number;
      signal: AbortSignal;
      getAffectedIds: () => Iterable<string>;
    }> = {},
  ) {
    return {
      requestId: "request-1",
      epoch: 1,
      deadlineAt: Date.now() + 1_000,
      getAffectedIds: () => ["A"],
      apply,
      ...overrides,
    };
  }

  function hasCode(code: EditProtectionErrorCode) {
    return (error: unknown) => {
      assert.ok(error instanceof EditProtectionError);
      assert.equal(error.code, code);
      return true;
    };
  }

  test("an Agent edit waits for the held target and prevents new overlap", async () => {
    const { session, states } = setup();
    const human = session.beginHumanEdit(["A"]);
    assert.ok(human);
    let applications = 0;
    const pending = session.runAgentEdit(request(() => ++applications));

    assert.equal(applications, 0);
    assert.equal(session.getState()?.phase, "scheduled");
    assert.equal(session.canStartHumanEdit(["A"]), false);
    assert.equal(session.beginHumanEdit(["A"]), null);
    assert.equal(session.updateHumanEdit(human, ["A"]), true);
    await nextTurn();
    assert.deepEqual(states.map((state) => state?.phase), ["scheduled", "waiting"]);

    session.endHumanEdit(human);
    assert.equal(await pending, 1);
    assert.equal(session.getState(), null);
    assert.equal(session.canStartHumanEdit(["A"]), true);
    await nextTurn();
    assert.equal(states.at(-1), null);
  });

  test("unrelated human gestures can start, update and remain active during protection", async () => {
    const { session } = setup();
    const a = session.beginHumanEdit(["A"]);
    assert.ok(a);
    let bValue = "B";
    const pending = session.runAgentEdit(request(() => {
      assert.equal(bValue, "B+");
      assert.equal(session.canStartHumanEdit(["B"]), true);
      return "A'";
    }));
    const b = session.beginHumanEdit(["B"]);
    assert.ok(b);
    assert.equal(session.updateHumanEdit(b, ["B", "C"]), true);
    bValue = "B+";
    session.endHumanEdit(a);
    assert.equal(await pending, "A'");
    assert.equal(session.updateHumanEdit(b, ["B", "C"]), true);
    session.endHumanEdit(b);
  });

  test("existing gestures finish held IDs but cannot expand into reserved targets", async () => {
    const { session } = setup();
    const a = session.beginHumanEdit(["A"]);
    const b = session.beginHumanEdit(["B"]);
    assert.ok(a && b);
    const pending = session.runAgentEdit(request(() => "done", {
      getAffectedIds: () => ["A", "C"],
    }));

    assert.equal(session.updateHumanEdit(a, ["A", "D"]), true);
    assert.equal(session.updateHumanEdit(a, ["A", "C"]), false);
    assert.equal(session.updateHumanEdit(b, ["B", "A"]), false);
    assert.equal(session.updateHumanEdit(b, ["B", "E"]), true);
    session.endHumanEdit(a);
    assert.equal(await pending, "done");
    session.endHumanEdit(b);
  });

  test("history permits unrelated B but rejects the active human A and Agent reservation", async () => {
    const { session } = setup();
    const human = session.beginHumanEdit(["A"]);
    assert.ok(human);
    assert.equal(session.canApplyHistoryEdit(["B"]), true);
    assert.equal(session.canApplyHistoryEdit(["A"]), false);
    assert.equal(session.canApplyHistoryEdit(["B", "A"]), false);
    const pending = session.runAgentEdit(request(() => "done", {
      getAffectedIds: () => ["A", "C"],
    }));
    assert.equal(session.canApplyHistoryEdit(["B"]), true);
    assert.equal(session.canApplyHistoryEdit(["A"]), false);
    assert.equal(session.canApplyHistoryEdit(["C"]), false);
    session.endHumanEdit(human);
    await pending;
    assert.equal(session.canApplyHistoryEdit(["A", "B", "C"]), true);
    session.destroy();
    assert.equal(session.canApplyHistoryEdit([]), false);
  });

  test("shrinking a human scope releases only the removed IDs", async () => {
    const { session } = setup();
    const human = session.beginHumanEdit(["A", "B"]);
    assert.ok(human);
    const pending = session.runAgentEdit(request(() => "A'"));
    assert.equal(session.updateHumanEdit(human, ["B"]), true);
    assert.equal(await pending, "A'");
    assert.equal(session.updateHumanEdit(human, ["B", "C"]), true);
    session.endHumanEdit(human);
  });

  test("affected IDs are recomputed after waiting before preparation commits", async () => {
    const { session } = setup();
    const a = session.beginHumanEdit(["A"]);
    const b = session.beginHumanEdit(["B"]);
    assert.ok(a && b);
    let targets = ["A"];
    let applications = 0;
    const pending = session.runAgentEdit(request(() => ++applications, {
      getAffectedIds: () => targets,
    }));
    targets = ["A", "B"];
    session.endHumanEdit(a);
    await nextTurn();
    assert.equal(applications, 0);
    assert.equal(session.canStartHumanEdit(["B"]), false);
    session.endHumanEdit(b);
    assert.equal(await pending, 1);
  });

  test("prepared actual writes can extend the reservation and retry after a human finishes", async () => {
    const { session } = setup();
    const b = session.beginHumanEdit(["B"]);
    assert.ok(b);
    let bValue = 1;
    let preparations = 0;
    let commits = 0;
    const pending = session.runAgentEdit(request((context) => {
      preparations++;
      const draft = bValue + 10;
      context.ensureAffected(["A", "B"]);
      context.ensureCurrent();
      commits++;
      return draft;
    }));
    assert.equal(preparations, 0);
    await nextTurn();
    assert.equal(preparations, 1);
    assert.equal(commits, 0);
    assert.equal(session.getState()?.phase, "waiting");
    assert.equal(session.beginHumanEdit(["B"]), null);
    assert.equal(session.updateHumanEdit(b, ["B"]), true);
    bValue = 2;
    session.endHumanEdit(b);
    assert.equal(await pending, 12);
    assert.equal(preparations, 2);
    assert.equal(commits, 1);
  });

  test("an idle request reserves immediately and prepares and commits together after dispatch", async () => {
    const { session } = setup();
    let afterApplyMicrotask = false;
    let committed = false;
    const pending = session.runAgentEdit(request((context) => {
      queueMicrotask(() => { afterApplyMicrotask = true; });
      context.ensureAffected(["A", "B"]);
      assert.equal(session.canStartHumanEdit(["B"]), false);
      assert.equal(afterApplyMicrotask, false);
      committed = true;
      return "committed";
    }));
    assert.equal(committed, false);
    assert.equal(session.getState()?.phase, "scheduled");
    assert.equal(session.canStartHumanEdit(["A"]), false);
    assert.equal(session.canStartHumanEdit(["B"]), true);
    assert.equal(await pending, "committed");
    assert.equal(committed, true);
    assert.equal(session.getState(), null);
    assert.equal(afterApplyMicrotask, true);
  });

  test("dispatch rechecks cancellation, scene lifetime and destruction before preparing", async () => {
    for (const reason of ["cancelled", "scene_changed", "destroyed"] as const) {
      const { session, nextEpoch } = setup();
      const abort = new AbortController();
      let preparations = 0;
      const pending = session.runAgentEdit(request(() => ++preparations, { signal: abort.signal }));
      assert.equal(session.getState()?.phase, "scheduled");
      if (reason === "cancelled") abort.abort();
      else if (reason === "scene_changed") nextEpoch();
      else session.destroy();
      await assert.rejects(pending, hasCode(reason));
      assert.equal(preparations, 0, reason);
      assert.equal(session.getState(), null);
    }
  });

  test("dispatch checks the wall-clock deadline before reading the scene again", async (t) => {
    const { session } = setup();
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    let reads = 0;
    let preparations = 0;
    const pending = session.runAgentEdit(request(() => ++preparations, {
      deadlineAt: now + 1_000,
      getAffectedIds: () => { reads++; return ["A"]; },
    }));
    assert.equal(reads, 1);
    now += 1_001;
    await assert.rejects(pending, hasCode("deadline_exceeded"));
    assert.equal(reads, 1);
    assert.equal(preparations, 0);
    assert.equal(session.getState(), null);
  });

  test("cancelled scheduled and waiting requests hand over without clearing the successor lease", async () => {
    for (const waitForHuman of [false, true]) {
      const { session } = setup();
      const human = waitForHuman ? session.beginHumanEdit(["A"]) : null;
      const abort = new AbortController();
      let firstCommitted = false;
      const first = session.runAgentEdit(request(() => { firstCommitted = true; }, { signal: abort.signal }));
      if (waitForHuman) {
        await nextTurn();
        assert.equal(session.getState()?.phase, "waiting");
      }
      abort.abort();
      assert.equal(session.getState(), null);
      const second = session.runAgentEdit(request((context) => {
        assert.equal(session.getState()?.requestId, "request-2");
        context.ensureCurrent();
        return "successor";
      }, { requestId: "request-2", getAffectedIds: () => ["B"] }));
      assert.equal(session.getState()?.requestId, "request-2");
      await assert.rejects(first, hasCode("cancelled"));
      assert.equal(await second, "successor");
      assert.equal(firstCommitted, false);
      assert.equal(session.getState(), null);
      if (human) session.endHumanEdit(human);
    }
  });

  test("only one Agent lease exists and a second request fails instead of queueing", async () => {
    const { session } = setup();
    const human = session.beginHumanEdit(["A"]);
    assert.ok(human);
    const first = session.runAgentEdit(request(() => "first"));
    await assert.rejects(
      session.runAgentEdit(request(() => "second", { requestId: "request-2" })),
      hasCode("busy"),
    );
    assert.equal(session.getState()?.requestId, "request-1");
    session.endHumanEdit(human);
    assert.equal(await first, "first");
  });

  test("cancellation releases protection and prevents a late application", async () => {
    const { session } = setup();
    const human = session.beginHumanEdit(["A"]);
    assert.ok(human);
    const abort = new AbortController();
    let committed = false;
    const pending = session.runAgentEdit(request(() => { committed = true; }, { signal: abort.signal }));
    const rejected = assert.rejects(pending, hasCode("cancelled"));
    abort.abort();
    await rejected;
    session.endHumanEdit(human);
    await nextTurn();
    assert.equal(committed, false);
    assert.equal(session.getState(), null);
    assert.equal(session.canStartHumanEdit(["A"]), true);
  });

  test("already aborted or expired requests never reserve or apply", async () => {
    const { session } = setup();
    const abort = new AbortController();
    abort.abort();
    let committed = false;
    await assert.rejects(session.runAgentEdit(request(() => { committed = true; }, {
      signal: abort.signal,
    })), hasCode("cancelled"));
    await assert.rejects(session.runAgentEdit(request(() => { committed = true; }, {
      deadlineAt: Date.now() - 1,
    })), hasCode("deadline_exceeded"));
    assert.equal(committed, false);
    assert.equal(session.getState(), null);
  });

  test("deadline expiry wakes a blocked request without waiting for the human", async () => {
    const { session } = setup();
    const human = session.beginHumanEdit(["A"]);
    assert.ok(human);
    let committed = false;
    await assert.rejects(session.runAgentEdit(request(() => { committed = true; }, {
      deadlineAt: Date.now() + 15,
    })), hasCode("deadline_exceeded"));
    assert.equal(committed, false);
    assert.equal(session.canStartHumanEdit(["A"]), true);
    session.endHumanEdit(human);
  });

  test("an epoch mismatch detected after a gesture finishes prevents stale commit", async () => {
    const { session, nextEpoch } = setup();
    const human = session.beginHumanEdit(["A"]);
    assert.ok(human);
    let committed = false;
    const pending = session.runAgentEdit(request(() => { committed = true; }));
    const rejected = assert.rejects(pending, hasCode("scene_changed"));
    nextEpoch();
    session.endHumanEdit(human);
    await rejected;
    assert.equal(committed, false);
    assert.equal(session.getState(), null);
  });

  test("scene reset invalidates old tokens and requests while a new scene can edit", async () => {
    const { session, nextEpoch } = setup();
    const human = session.beginHumanEdit(["A"]);
    assert.ok(human);
    let oldCommitted = false;
    const pending = session.runAgentEdit(request(() => { oldCommitted = true; }));
    const rejected = assert.rejects(pending, hasCode("scene_changed"));
    nextEpoch();
    session.reset();
    assert.equal(session.updateHumanEdit(human, ["A"]), false);
    assert.equal(await session.runAgentEdit(request(() => "new scene", { epoch: 2 })), "new scene");
    await rejected;
    assert.equal(oldCommitted, false);
    assert.equal(session.getState(), null);
  });

  test("destroy invalidates all editing and blocks a waiting request", async () => {
    const { session } = setup();
    const human = session.beginHumanEdit(["A"]);
    assert.ok(human);
    const pending = session.runAgentEdit(request(() => "unreachable"));
    const rejected = assert.rejects(pending, hasCode("destroyed"));
    session.destroy();
    await rejected;
    assert.equal(session.beginHumanEdit(["B"]), null);
    assert.equal(session.updateHumanEdit(human, ["A"]), false);
    await assert.rejects(session.runAgentEdit(request(() => "unreachable")), hasCode("destroyed"));
    assert.equal(session.getState(), null);
  });

  test("synchronous preparation failure releases the lease", async () => {
    const { session } = setup();
    await assert.rejects(session.runAgentEdit(request(() => {
      throw new Error("invalid batch");
    })), /invalid batch/);
    assert.equal(session.getState(), null);
    assert.equal(await session.runAgentEdit(request(() => "next")), "next");
  });

  test("asynchronous apply is rejected and an escaped context loses commit permission", async () => {
    const { session } = setup();
    let escaped!: AgentEditProtectionContext;
    await assert.rejects(session.runAgentEdit(request((context) => {
      escaped = context;
      return Promise.resolve("invalid asynchronous batch");
    })), hasCode("invalid_async_apply"));
    assert.throws(() => escaped.ensureCurrent(), hasCode("scene_changed"));
    assert.equal(session.getState(), null);
  });

  test("state snapshots cannot mutate reservations and observers run outside the transaction", async () => {
    const { session, states } = setup();
    const human = session.beginHumanEdit(["A"]);
    assert.ok(human);
    const pending = session.runAgentEdit(request(() => "done"));
    const state = session.getState();
    assert.ok(state);
    (state.elementIds as Set<string>).clear();
    assert.equal(session.canStartHumanEdit(["A"]), false);
    assert.equal(states.length, 0);
    await nextTurn();
    assert.deepEqual(states.map((state) => state?.phase), ["scheduled", "waiting"]);
    session.endHumanEdit(human);
    await pending;
  });
}

// Domain relationships and protection scope
{
  function element(id: string, extra: Record<string, unknown> = {}): CanvasEditorElement {
    return { id, type: "rectangle", groupIds: [], frameId: null, isDeleted: false, boundElements: null, ...extra } as CanvasEditorElement;
  }
  function ids(set: Set<string>) { return [...set].sort(); }

  test("standalone A and B have disjoint protection footprints", () => {
    const elements = [element("A"), element("B")];
    assert.deepEqual(ids(getCanvasEditFootprint([{ action: "update", id: "A", changes: { x: 1 } }], elements)), ["A"]);
    assert.deepEqual(ids(expandHumanEditFootprint(["B"], elements)), ["B"]);
    assert.deepEqual(ids(getCanvasEditFootprint([{ action: "create", element: { type: "rectangle", x: 0, y: 0 } }], elements)), []);
  });

  test("direct binding effects include arrow labels while the remote graph stays available", () => {
    const elements = [
      element("A"), element("B"), element("C"),
      element("AB", { type: "arrow", startBinding: { elementId: "A" }, endBinding: { elementId: "B" } }),
      element("AB-label", { type: "text", containerId: "AB" }),
      element("BC", { type: "arrow", startBinding: { elementId: "B" }, endBinding: { elementId: "C" } }),
    ];
    const protectedIds = getCanvasEditFootprint([{ action: "update", id: "A", changes: { x: 1 } }], elements);
    assert.deepEqual(ids(protectedIds), ["A", "AB", "AB-label"]);
    const humanB = expandHumanEditFootprint(["B"], elements);
    assert.equal([...humanB].some((id) => protectedIds.has(id)), true, "B also modifies the shared arrow");
    const humanC = expandHumanEditFootprint(["C"], elements);
    assert.equal([...humanC].some((id) => protectedIds.has(id)), false, "the other graph branch is independent");
  });

  test("bound text editing protects its resizing container and local dependants", () => {
    const elements = [
      element("A", { boundElements: [{ id: "text", type: "text" }, { id: "AB", type: "arrow" }] }),
      element("text", { type: "text", containerId: "A" }),
      element("AB", { type: "arrow", startBinding: { elementId: "A" }, endBinding: { elementId: "B" } }),
      element("B"),
    ];
    assert.deepEqual(ids(getCanvasEditFootprint([{ action: "update", id: "text", changes: { text: "longer" } }], elements)), ["A", "AB", "text"]);
  });

  test("arrow creation protects only referenced endpoints; arrow deletion includes both endpoints", () => {
    const elements = [
      element("A"), element("B"),
      element("AB", { type: "arrow", startBinding: { elementId: "A" }, endBinding: { elementId: "B" } }),
    ];
    assert.deepEqual(ids(getCanvasEditFootprint([{ action: "create", element: { type: "arrow", x: 0, y: 0, startElementId: "A", endElementId: "B" } }], elements)), ["A", "B"]);
    assert.deepEqual(ids(getCanvasEditFootprint([{ action: "delete", id: "AB" }], elements)), ["A", "AB", "B"]);
  });

  test("frame-wide changes include children while siblings remain independent targets", () => {
    const elements = [
      element("frame", { type: "frame" }),
      element("A", { frameId: "frame" }), element("B", { frameId: "frame" }), element("other"),
    ];
    assert.deepEqual(ids(getCanvasEditFootprint([{ action: "delete", id: "frame" }], elements)), ["A", "B", "frame"]);
    assert.deepEqual(ids(expandHumanEditFootprint(["frame"], elements)), ["A", "B", "frame"]);
    assert.deepEqual(ids(expandHumanEditFootprint(["A"], elements)), ["A"]);
  });

  test("group membership changes and reorder include local group members only", () => {
    const elements = [
      element("A", { groupIds: ["group-1"] }), element("B", { groupIds: ["group-1"] }),
      element("C", { groupIds: ["group-2"] }),
    ];
    assert.deepEqual(ids(getCanvasEditFootprint([{ action: "reorder", id: "A", direction: "front" }], elements)), ["A", "B"]);
    assert.deepEqual(ids(getCanvasEditFootprint([{ action: "ungroup", ids: ["A", "B"] }], elements)), ["A", "B"]);
    assert.deepEqual(ids(expandHumanEditFootprint(["A"], elements)), ["A", "B"]);
    assert.deepEqual(ids(getCanvasEditFootprint([{ action: "setLocked", id: "A", locked: true }], elements)), ["A"]);
  });

  test("human group edits include binding effects of members without expanding other groups", () => {
    const elements = [
      element("A", { groupIds: ["group-1"] }), element("B", { groupIds: ["group-1"] }),
      element("BC", { type: "arrow", startBinding: { elementId: "B" }, endBinding: { elementId: "C" } }),
      element("C", { groupIds: ["group-2"] }), element("D", { groupIds: ["group-2"] }),
    ];
    assert.deepEqual(ids(expandHumanEditFootprint(["A"], elements)), ["A", "B", "BC"]);
  });

  test("duplication protects source and bound text while independent neighbours stay live", () => {
    const elements = [
      element("A", { boundElements: [{ id: "text", type: "text" }] }),
      element("text", { type: "text", containerId: "A" }), element("B"),
    ];
    assert.deepEqual(ids(getCanvasEditFootprint([{ action: "duplicate", id: "A" }], elements)), ["A", "text"]);
  });
}

// Stable live references during scene submission
{
  function element(id: string) {
    return {
      id, x: 0, version: 1, versionNonce: 10, index: "a0", isDeleted: false,
      points: [[0, 0], [10, 20]], boundElements: [{ id: "text", type: "text" }],
      customData: { extra: { source: "user" } },
    };
  }

  test("only Agent-modified elements replace live instances; unrelated B+ stays live", () => {
    const a = element("A");
    const b = element("B");
    b.x = 90;
    const live = [a, b];
    const draft = structuredClone(live);
    draft[0].x = 40;
    const result = reconcileCanvasEditElements(live, draft);
    assert.deepEqual([...result.changedIds], ["A"]);
    assert.equal(result.elements[0], draft[0]);
    assert.equal(result.elements[1], b);
    assert.equal(result.elements[1].x, 90);
    b.x = 100;
    assert.equal(result.elements[1].x, 100, "the user's pending gesture keeps its live object");
    assert.equal(a.x, 0, "isolated calculations never mutate the original A");
  });

  test("all element fields participate in semantic comparison even without a new nonce", () => {
    for (const mutate of [
      (item: ReturnType<typeof element>) => { item.points[1][1] = 30; },
      (item: ReturnType<typeof element>) => { item.boundElements[0].id = "other-text"; },
      (item: ReturnType<typeof element>) => { item.customData.extra.source = "agent"; },
      (item: ReturnType<typeof element>) => { item.index = "a1"; },
      (item: ReturnType<typeof element>) => { item.isDeleted = true; },
    ]) {
      const live = element("A");
      const draft = structuredClone(live);
      mutate(draft);
      const result = reconcileCanvasEditElements([live], [draft]);
      assert.deepEqual([...result.changedIds], ["A"]);
      assert.equal(result.elements[0], draft);
    }
  });

  test("draft order, creations and tombstones are preserved alongside stable references", () => {
    const a = element("A");
    const b = element("B");
    const deletedA = { ...structuredClone(a), isDeleted: true };
    const created = element("C");
    const result = reconcileCanvasEditElements([a, b], [structuredClone(b), deletedA, created]);
    assert.deepEqual(result.elements.map((item) => item.id), ["B", "A", "C"]);
    assert.equal(result.elements[0], b);
    assert.deepEqual([...result.changedIds], ["A", "C"]);
  });

  test("JSON-clone omission of optional undefined properties preserves semantic identity", () => {
    const live = { ...element("A"), optional: undefined };
    const draft = JSON.parse(JSON.stringify(live)) as typeof live;
    const result = reconcileCanvasEditElements([live], [draft]);
    assert.equal(result.elements[0], live);
    assert.equal(result.changedIds.size, 0);
    assert.equal(canvasEditValuesEqual({ a: undefined }, { b: undefined }), true);
    assert.equal(canvasEditValuesEqual({ a: 1 }, { b: 1 }), false);
    assert.equal(canvasEditValuesEqual({ a: null }, {}), false);
    assert.equal(canvasEditValuesEqual([1, 2], [2, 1]), false);
  });
}

// Action permission policy
{
  type Elements = Parameters<typeof getActionHumanEditTargets>[1];
  type State = Parameters<typeof getActionHumanEditTargets>[2];

  const elements = [
    { id: "A", locked: true, groupIds: ["group-1"] },
    { id: "B", locked: false, groupIds: ["group-1"] },
    { id: "C", locked: false, groupIds: [] },
  ] as unknown as Elements;

  const state = (overrides: Partial<State> = {}): State => ({
    selectedElementIds: { A: true },
    selectedGroupIds: {},
    editingLinearElement: null,
    multiElement: null,
    newElement: null,
    pendingImageElementId: null,
    ...overrides,
  });

  test("read, view and selection actions remain available while selected elements are protected", () => {
    for (const name of [
      "copy", "copyAsPng", "copyAsSvg", "copyText", "copyElementLink", "paste",
      "selectAll", "setZoom", "zoomToFit", "toggleHandTool", "toggleEraserTool", "viewMode",
      "saveFileToDisk", "undo", "redo",
    ] as const) {
      assert.equal(getActionHumanEditTargets(name, elements, state()), null, name);
    }
  });

  test("mutating actions and editing-mode entry points report their selected primary targets", () => {
    for (const name of [
      "cut", "deleteSelectedElements", "duplicateSelection", "group", "sendToBack",
      "alignTop", "flipHorizontal", "bindText", "toggleElementLock", "hyperlink",
      "linkToElement", "toggleLinearEditor", "cropEditor", "autoResize",
    ] as const) {
      assert.deepEqual([...getActionHumanEditTargets(name, elements, state())!], ["A"], name);
    }
  });

  test("global actions and ungroup use their actual document scope, independently of selection", () => {
    assert.deepEqual([...getActionHumanEditTargets("clearCanvas", elements, state())!], ["A", "B", "C"]);
    assert.deepEqual([...getActionHumanEditTargets("unlockAllElements", elements, state())!], ["A"]);
    assert.deepEqual([...getActionHumanEditTargets("ungroup", elements, state({ selectedGroupIds: { "group-1": true } }))!], ["A", "B"]);
  });

  test("linear-point deletion and duplication protect their edited element even without selection", () => {
    const editing = state({
      selectedElementIds: {},
      editingLinearElement: { elementId: "B" } as State["editingLinearElement"],
    });
    for (const name of ["cut", "deleteSelectedElements", "duplicateSelection"] as const) {
      assert.deepEqual([...getActionHumanEditTargets(name, elements, editing)!], ["B"], name);
    }
  });

  test("finalize is scoped to the continuing gesture rather than an unrelated selected target", () => {
    assert.deepEqual([...getActionHumanEditTargets("finalize", elements, state())!], []);
    assert.deepEqual([...getActionHumanEditTargets("finalize", elements, state({
      multiElement: { id: "B" } as State["multiElement"],
      pendingImageElementId: "C",
    }))!], ["C", "B"]);
    assert.deepEqual([...getActionHumanEditTargets("finalize", elements, state({
      editingLinearElement: { elementId: "B" } as State["editingLinearElement"],
      pendingImageElementId: "C",
    }))!], ["B"]);
  });
}

// History isolation and active gestures
{
  // History owns stack consumption. Domain increments are supplied as minimal
  // structural fixtures so these tests exercise that boundary without a renderer.
  function increment(ids: string[], visible = true, stateResult?: AppState) {
    let applications = 0;
    let stateApplications = 0;
    const elementsChange = {
      affectedElementIds: () => ids.values(),
      isEmpty: () => ids.length === 0,
      inverse: () => elementsChange,
      applyLatestChanges: () => elementsChange,
      applyTo: (elements: SceneElementsMap): [SceneElementsMap, boolean] => {
        applications++;
        return [elements, visible];
      },
    } as unknown as ElementsChange;
    const appStateChange = {
      isEmpty: () => !stateResult,
      inverse: () => appStateChange,
      applyTo: (appState: AppState): [AppState, boolean] => {
        stateApplications++;
        return [stateResult ?? appState, !!stateResult];
      },
    } as unknown as AppStateChange;
    return {
      elementsChange,
      appStateChange,
      applications: () => applications,
      stateApplications: () => stateApplications,
    };
  }

  function setup() {
    const history = new History();
    const elements = new Map() as SceneElementsMap;
    const appState = {} as AppState;
    const snapshot = { elements } as Snapshot;
    return { history, elements, appState, snapshot };
  }

  test("a protected undo increment is checked before consumption and creates no redo entry", () => {
    const { history, elements, appState, snapshot } = setup();
    const change = increment(["A"]);
    history.record(change.elementsChange, change.appStateChange);
    const seen: string[][] = [];

    assert.equal(history.undo(elements, appState, snapshot, (ids) => {
      seen.push([...ids]);
      return false;
    }), undefined);
    assert.deepEqual(seen, [["A"]]);
    assert.equal(change.applications(), 0);
    assert.equal(history.isUndoStackEmpty, false);
    assert.equal(history.isRedoStackEmpty, true);

    assert.ok(history.undo(elements, appState, snapshot, () => true));
    assert.equal(change.applications(), 1);
    assert.equal(history.isUndoStackEmpty, true);
    assert.equal(history.isRedoStackEmpty, false);
  });

  test("a protected redo increment remains available after the lease releases", () => {
    const { history, elements, appState, snapshot } = setup();
    const change = increment(["A", "bound-text"]);
    history.record(change.elementsChange, change.appStateChange);
    history.undo(elements, appState, snapshot);
    const seen: string[][] = [];

    assert.equal(history.redo(elements, appState, snapshot, (ids) => {
      seen.push([...ids]);
      return false;
    }), undefined);
    assert.deepEqual(seen, [["A", "bound-text"]]);
    assert.equal(change.applications(), 1);
    assert.equal(history.isUndoStackEmpty, true);
    assert.equal(history.isRedoStackEmpty, false);

    assert.ok(history.redo(elements, appState, snapshot, () => true));
    assert.equal(change.applications(), 2);
    assert.equal(history.isUndoStackEmpty, false);
    assert.equal(history.isRedoStackEmpty, true);
  });

  test("protecting A permits an unrelated B undo and then preserves the A entry", () => {
    const { history, elements, appState, snapshot } = setup();
    const a = increment(["A"]);
    const b = increment(["B"]);
    history.record(a.elementsChange, a.appStateChange);
    history.record(b.elementsChange, b.appStateChange);
    const guard = (ids: Iterable<string>) => !new Set(ids).has("A");

    assert.ok(history.undo(elements, appState, snapshot, guard));
    assert.equal(b.applications(), 1);
    assert.equal(a.applications(), 0);
    assert.equal(history.undo(elements, appState, snapshot, guard), undefined);
    assert.equal(a.applications(), 0);
    assert.equal(history.isUndoStackEmpty, false);
    assert.equal(history.isRedoStackEmpty, false);

    assert.ok(history.redo(elements, appState, snapshot, guard));
    assert.equal(b.applications(), 2);
    assert.equal(history.isRedoStackEmpty, true);
  });

  test("invisible increments also acquire permission before History applies them", () => {
    const { history, elements, appState, snapshot } = setup();
    const visible = increment(["B"]);
    const invisibleProtected = increment(["A"], false);
    history.record(visible.elementsChange, visible.appStateChange);
    history.record(invisibleProtected.elementsChange, invisibleProtected.appStateChange);

    assert.equal(history.undo(elements, appState, snapshot, (ids) => !new Set(ids).has("A")), undefined);
    assert.equal(invisibleProtected.applications(), 0);
    assert.equal(visible.applications(), 0);
    assert.equal(history.isRedoStackEmpty, true);

    assert.ok(history.undo(elements, appState, snapshot, () => true));
    assert.equal(invisibleProtected.applications(), 1);
    assert.equal(visible.applications(), 1);
    assert.equal(history.isUndoStackEmpty, true);
  });

  test("an active A gesture can undo B in one invocation through selection-only history", () => {
    const { history, elements, snapshot } = setup();
    const session = new EditProtectionSession({ getEpoch: () => 1 });
    const human = session.beginHumanEdit(["A"]);
    assert.ok(human);
    const activeState = { selectedElementIds: { A: true }, cursorButton: "down" } as unknown as AppState;
    const priorState = { selectedElementIds: { B: true }, cursorButton: "up" } as unknown as AppState;
    const b = increment(["B"], true, priorState);
    const selectionOnly = increment([], false, priorState);
    history.record(b.elementsChange, b.appStateChange);
    history.record(selectionOnly.elementsChange, selectionOnly.appStateChange);

    const result = history.undo(
      elements,
      activeState,
      snapshot,
      (ids) => session.canApplyHistoryEdit(ids),
      { preserveAppState: true },
    );
    assert.ok(result);
    assert.equal(result[1], activeState);
    assert.equal(selectionOnly.applications(), 1);
    assert.equal(b.applications(), 1, "selection-only history does not stop the visible B undo");
    assert.equal(selectionOnly.stateApplications(), 0);
    assert.equal(b.stateApplications(), 0);
    assert.equal(history.isUndoStackEmpty, true);

    const redo = history.redo(
      elements,
      activeState,
      snapshot,
      (ids) => session.canApplyHistoryEdit(ids),
      { preserveAppState: true },
    );
    assert.ok(redo);
    assert.equal(redo[1], activeState);
    assert.equal(b.applications(), 2);
    assert.equal(b.stateApplications(), 0);
    session.endHumanEdit(human);
  });

  test("active A protection keeps its increment and preview while B history remains independent", () => {
    const { history, snapshot } = setup();
    const session = new EditProtectionSession({ getEpoch: () => 1 });
    const human = session.beginHumanEdit(["A"]);
    assert.ok(human);
    const aPreview = { id: "A", x: 23 };
    const elements = new Map([["A", aPreview]]) as unknown as SceneElementsMap;
    const activeState = { selectedElementIds: { A: true }, cursorButton: "down" } as unknown as AppState;
    const a = increment(["A"]);
    const b = increment(["B"]);
    history.record(a.elementsChange, a.appStateChange);
    history.record(b.elementsChange, b.appStateChange);
    const guard = (ids: Iterable<string>) => session.canApplyHistoryEdit(ids);

    const result = history.undo(elements, activeState, snapshot, guard, { preserveAppState: true });
    assert.ok(result);
    assert.equal(result[0].get("A"), aPreview);
    assert.equal(aPreview.x, 23);
    assert.equal(snapshot.elements.has("A"), false, "History leaves snapshot ownership to Store");
    assert.equal(history.undo(elements, activeState, snapshot, guard, { preserveAppState: true }), undefined);
    assert.equal(a.applications(), 0);
    assert.equal(history.isUndoStackEmpty, false);
    session.endHumanEdit(human);
    assert.ok(history.undo(elements, activeState, snapshot, guard));
    assert.equal(a.applications(), 1);
  });
}
