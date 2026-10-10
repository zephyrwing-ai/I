import { createRef } from "react";
import { createRoot } from "react-dom/client";
import { CanvasSurface, type CanvasSurfaceHandle } from "../../../canvas/ui/CanvasSurface";
import { convertToCanvasEditorElements } from "../../../canvas/engine/editor";
import type { AgentAPI, CanvasDocumentResult, CanvasSaveRequest } from "../../../shell/shared/ipc";
import type { CanvasEditRequest, CanvasEditResult } from "../../../canvas/commands/types";

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function until(condition: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  throw new Error(`Canvas save fixture did not reach: ${description}`);
}

export async function checkCanvasSurfacePersistence() {
  const container = document.getElementById("root")!;
  const root = createRoot(container);
  const ref = createRef<CanvasSurfaceHandle>();
  const projectId = "surface-project";
  const requests: CanvasSaveRequest[] = [];
  const results: CanvasEditResult[] = [];
  let disk: CanvasDocumentResult = {
    document: { elements: convertToCanvasEditorElements([{ type: "rectangle", id: "surface-original", x: 100, y: 120, width: 120, height: 80 }], { regenerateIds: false }), appState: {}, files: {} },
    version: { revision: 1, fingerprint: "1".repeat(64) },
  };
  let pending: CanvasEditRequest | null = {
    requestId: "cold-create", runId: "surface-run", projectId, deadlineAt: Date.now() + 20_000,
    sourceElements: [], operations: [{ action: "create", element: { type: "rectangle", x: 300, y: 120, width: 120, height: 80 } }],
  };
  const previousAPI = window.agentAPI;
  let canRelease = true;
  const onCanReleaseChange = (next: boolean) => { canRelease = next; };
  const onContextPrepared = () => undefined;
  const onEditResult = (result: CanvasEditResult) => {
    results.push(result);
    pending = null;
    render();
  };
  const render = () => root.render(
    <div style={{ position: "relative", width: 900, height: 650 }}>
      <CanvasSurface ref={ref} projectId={projectId} pendingEdit={pending} onEditResult={onEditResult} onContextPrepared={onContextPrepared} onCanReleaseChange={onCanReleaseChange} />
    </div>,
  );
  window.agentAPI = {
    loadCanvasDocument: async (scope: string | null) => {
      if (scope !== projectId) throw new Error("wrong project load");
      return structuredClone(disk);
    },
    saveCanvasDocument: async (request: CanvasSaveRequest) => {
      if (request.projectId !== projectId) throw new Error("wrong project save");
      requests.push(structuredClone(request));
      if (request.expectedVersion.revision !== disk.version.revision || request.expectedVersion.fingerprint !== disk.version.fingerprint) {
        return { status: "conflict", version: { ...disk.version } };
      }
      const revision = disk.version.revision + 1;
      disk = { document: structuredClone(request.document), version: { revision, fingerprint: String(revision).padStart(64, "0") } };
      return { status: "saved", version: { ...disk.version } };
    },
  } as unknown as AgentAPI;
  try {
    render();
    await until(() => results.length === 1, "cold-start Canvas command confirmation");
    const coldStart = { ok: results[0].ok, savedElements: disk.document.elements.length, requests: requests.length, canRelease };
    const initialRequests = requests.length;
    window.dispatchEvent(new Event("focus"));
    await wait(550);
    const focusSaved = requests.length !== initialRequests;
    const baselineElement = structuredClone(disk.document.elements.find((element) => element.id === "surface-original")!);
    disk.document.elements.push(...convertToCanvasEditorElements([{ type: "ellipse", id: "external-element", x: 500, y: 120, width: 100, height: 100 }], { regenerateIds: false }));
    disk.version = { ...disk.version, fingerprint: "f".repeat(64) };
    pending = {
      requestId: "conflicting-update", runId: "surface-run", projectId, deadlineAt: Date.now() + 20_000,
      sourceElements: [baselineElement], operations: [{ action: "update", id: "surface-original", changes: { x: 200 } }],
    };
    render();
    await until(() => results.length === 2, "persistence conflict feedback");
    await until(() => !!document.querySelector('[role="alert"]'), "draft conflict controls").catch((error) => {
      throw new Error(`${error.message}; result=${JSON.stringify(results[1])}; saves=${requests.length}; text=${container.textContent}`);
    });
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="alert"] button')];
    const conflict = {
      code: results[1].error,
      localX: results[1].appliedElements?.find((element) => element.id === "surface-original")?.x,
      diskX: disk.document.elements.find((element) => element.id === "surface-original")?.x,
      externalPreserved: disk.document.elements.some((element) => element.id === "external-element"),
      actions: buttons.map((button) => button.textContent),
      canRelease,
    };
    const conflictRequests = requests.length;
    window.dispatchEvent(new Event("focus"));
    await wait(550);
    const conflictRetried = requests.length !== conflictRequests;
    buttons.find((button) => button.textContent === "Reload saved")!.click();
    await until(() => !document.querySelector(".canvas-panel-loading") && !document.querySelector('[role="alert"]') && canRelease, "saved-scene reload");
    pending = {
      requestId: "after-reload", runId: "surface-run", projectId, deadlineAt: Date.now() + 20_000,
      sourceElements: [], operations: [{ action: "create", element: { type: "text", x: 200, y: 300, text: "Saved after conflict" } }],
    };
    render();
    await until(() => results.length === 3, "editing after saved-scene reload");
    return { coldStart, focusSaved, conflict, conflictRetried, recovered: { ok: results[2].ok, elements: disk.document.elements.length, canRelease } };
  } finally {
    root.unmount();
    window.agentAPI = previousAPI;
  }
}
