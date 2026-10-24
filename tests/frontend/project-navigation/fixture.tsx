import { createRoot } from "react-dom/client";
import App from "../../../frontend/src/App";
import { useProjects } from "../../../frontend/src/workbench/project/useProjects";
import "../../../frontend/src/styles.css";
import type { AgentAPI, AgentEvent, HistoryPageResult, ProjectActionRequest, ProjectDescriptor } from "../../../shell/shared/ipc";
import { canvasOperations } from "./canvas";

const ordinary: ProjectDescriptor = { projectId: null, displayName: "I", canonicalPath: null };
const alpha: ProjectDescriptor = { projectId: "alpha", displayName: "I", canonicalPath: "/projects/I" };
const beta: ProjectDescriptor = { projectId: "beta", displayName: "Design", canonicalPath: "/projects/Design" };
const added: ProjectDescriptor = { projectId: "added", displayName: "Research", canonicalPath: "/projects/Research" };
let active = ordinary;
let projects = [alpha, beta];
let picker: "add" | "cancel" | "error" = "add";
let failingProject: string | null = null;
let delayedScope: string | null = null;
let listReads = 0;
let failNextListRead = true;
let delayNextListRead = 0;
let pickerCalls = 0;
let confirmDelete = false;
const projectActions: ProjectActionRequest[] = [];
const historyReads: Array<string | null> = [];
const listeners = new Set<(event: AgentEvent) => void>();
const errors: string[] = [];
window.addEventListener("error", (event) => errors.push(event.message));
window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function page(projectId: string | null): HistoryPageResult {
  const scope = projectId ?? "ordinary";
  const base = { projectId, runId: `${scope}:run`, revision: 0, toolCallId: null, createdAt: 1700000000000, status: "completed" as const };
  return {
    projectId, nextCursor: null, hasMore: false, snapshotOrder: 2,
    entries: [
      { ...base, entryId: `${scope}:user`, entryOrder: 1, type: "user_message", turnId: null, payload: { role: "user", content: `${scope} conversation` }, completedAt: null, durationMs: null },
      { ...base, entryId: `${scope}:answer`, entryOrder: 2, type: "assistant_message", turnId: `${scope}:turn`, payload: { role: "assistant", content: `Ready in ${scope}.` }, completedAt: 1700000001000, durationMs: 1000 },
    ],
  };
}

localStorage.setItem("workbench.modelOptionId", "model-test");
const api: Partial<AgentAPI> = {
  getActiveProject: async () => active,
  listProjects: async () => {
    listReads += 1;
    if (failNextListRead) { failNextListRead = false; throw new Error("Project list unavailable"); }
    const snapshot = [...projects];
    const delay = delayNextListRead;
    delayNextListRead = 0;
    if (delay) await pause(delay);
    return snapshot;
  },
  activateProject: async (id) => {
    canvasOperations.push(`activate:${id}`);
    if (id === failingProject) throw new Error("Project directory unavailable");
    const project = projects.find((entry) => entry.projectId === id);
    if (!project) throw new Error("Unknown project");
    active = project;
    return project;
  },
  selectProject: async () => {
    pickerCalls += 1;
    if (picker === "cancel") return null;
    if (picker === "error") throw new Error("Folder picker failed");
    if (!projects.some((entry) => entry.projectId === added.projectId)) projects = [...projects, added];
    active = added;
    return added;
  },
  clearProject: async () => { active = ordinary; return ordinary; },
  performProjectAction: async (request) => {
    projectActions.push(request);
    const target = projects.find((entry) => entry.projectId === request.projectId)!;
    if (request.action === "delete" && !confirmDelete) {
      return { status: "cancelled", activeProject: active };
    }
    if (request.action === "reveal") return { status: "completed", activeProject: active };
    if (request.action === "delete") {
      projects = projects.filter((entry) => entry.projectId !== request.projectId);
      if (active.projectId === request.projectId) active = ordinary;
    } else if (request.action !== "reveal") {
      const updated = { ...target, ...(request.action === "rename" ? { displayName: request.name! } : { pinned: request.action === "pin" }) };
      projects = projects.map((entry) => entry.projectId === request.projectId ? updated : entry);
      if (active.projectId === request.projectId) active = updated;
      const creationOrder = [alpha.projectId, beta.projectId, added.projectId];
      projects.sort((left, right) => Number(!!right.pinned) - Number(!!left.pinned) || creationOrder.indexOf(left.projectId) - creationOrder.indexOf(right.projectId));
    }
    return { status: "completed", projects: [...projects], activeProject: active };
  },
  loadHistoryPage: async () => {
    const captured = active.projectId;
    historyReads.push(captured);
    if (captured === delayedScope && captured !== null) await pause(200);
    return page(captured);
  },
  listProviderProfiles: async () => [{
    providerProfileId: "provider-test", name: "Test", baseURL: "https://example.invalid", credentialConfigured: true,
    models: [{ modelOptionId: "model-test", providerProfileId: "provider-test", providerName: "Test", modelId: "test", displayName: "Test model", available: true, imported: true, state: "saved" }],
  }],
  onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
  onCanvasEditRequest: () => () => undefined,
  onCanvasEditCancel: () => () => undefined,
  run: async () => ({ ok: true, runId: "live-run", inputId: "live-input", createdAt: Date.now() }),
  stop: () => undefined,
};
window.agentAPI = api as AgentAPI;
createRoot(document.getElementById("root")!).render(<App />);

async function until(predicate: () => boolean, description: string): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${description}. ${document.body.textContent}`);
    await pause(16);
  }
}
function click(selector: string): void {
  const button = document.querySelector<HTMLButtonElement>(selector);
  if (!button || button.disabled) throw new Error(`Button unavailable: ${selector}`);
  button.click();
}
function expect(condition: unknown, description: string): void {
  if (!condition) throw new Error(description);
}
function historyVisible(scope: string): boolean {
  return document.querySelector(".message-stream")?.textContent?.includes(`${scope} conversation`) ?? false;
}
function projectOrder(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-project-id]"), (element) => element.dataset.projectId!);
}
async function openMenu(id: string, label: string): Promise<void> {
  await until(() => document.querySelector<HTMLButtonElement>(`[data-project-id="${id}"]`)?.disabled === false, `project ready for ${label}`);
  const button = document.querySelector<HTMLButtonElement>(`[data-project-id="${id}"]`)!;
  button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: window.innerWidth - 10, clientY: window.innerHeight - 10 }));
  await until(() => !!document.querySelector('[role="menu"]'), `project menu for ${label}`);
  const bounds = document.querySelector('[role="menu"]')!.getBoundingClientRect();
  expect(bounds.right <= window.innerWidth && bounds.bottom <= window.innerHeight, "menu should fit inside the window");
  const items = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
  expect(items.length === 4 && !items.some((item) => item.textContent?.includes("Fork")), "menu should expose the four approved actions");
  const item = items.find((entry) => entry.textContent === label);
  expect(item, `menu item ${label}`);
  item!.click();
}

async function verifyProjectSnapshotRaces(): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let cache: ReturnType<typeof useProjects> | undefined;
  const originalRead = window.agentAPI.listProjects;
  const reads: Array<(projects: ProjectDescriptor[]) => void> = [];
  window.agentAPI.listProjects = () => new Promise((resolve) => reads.push(resolve));
  function CacheHarness() { cache = useProjects(); return null; }
  try {
    root.render(<CacheHarness />);
    await until(() => !!cache, "cache harness");
    const initial = cache!.ensureLoaded();
    expect(cache!.ensureLoaded() === initial, "concurrent first loads should share a request");
    await until(() => reads.length === 1, "initial list request");
    const fresh = cache!.refresh();
    await until(() => reads.length === 2, "refresh supersedes pending initial read");
    reads[1]([added]);
    await fresh;
    await until(() => cache!.projects[0]?.projectId === added.projectId, "fresh snapshot");
    reads[0]([alpha]);
    await initial;
    expect(cache!.projects[0]?.projectId === added.projectId, "late initial read should preserve the fresh snapshot");

    const stale = cache!.refresh();
    await until(() => reads.length === 3, "read preceding metadata commit");
    cache!.replace([beta]);
    await until(() => cache!.projects[0]?.projectId === beta.projectId, "metadata snapshot");
    reads[2]([alpha]);
    await stale;
    expect(cache!.projects[0]?.projectId === beta.projectId, "a late read should preserve committed metadata");

    window.agentAPI.listProjects = () => { throw new Error("Read failed synchronously"); };
    await cache!.refresh();
    await until(() => !!cache!.error, "failed refresh");
    expect(cache!.projects[0]?.projectId === beta.projectId && !cache!.loading, "failed refresh should retain the last snapshot");
    window.agentAPI.listProjects = async () => [added];
    await cache!.refresh();
    await until(() => cache!.projects[0]?.projectId === added.projectId && !cache!.error, "retry after a synchronous failure");
  } finally {
    window.agentAPI.listProjects = originalRead;
    root.unmount();
    container.remove();
  }
}

async function verifyProjectsResize(panel: HTMLElement): Promise<void> {
  const resizer = document.querySelector<HTMLElement>('[aria-label="Resize projects sidebar"]')!;
  await until(() => panel.classList.contains('phase-open'), 'project width animation');
  const initialWidth = panel.getBoundingClientRect().width;
  resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await until(() => panel.getBoundingClientRect().width >= initialWidth + 15, 'keyboard expands projects');
  expect(Number(localStorage.getItem('workbench.projectsSidebarWidth')) === initialWidth + 16, 'project width should persist after keyboard resize');

  const beginDrag = (pointerId: number): number => {
    const edge = resizer.getBoundingClientRect();
    const startX = edge.left + edge.width / 2;
    resizer.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId, button: 0, clientX: startX, clientY: edge.top + 80 }));
    return startX;
  };
  const dragStart = beginDrag(21);
  window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 21, clientX: dragStart + 80 }));
  await until(() => panel.getBoundingClientRect().width >= initialWidth + 95, 'project drag updates its visible width');
  expect(Math.abs(document.querySelector('.projects-panel-body')!.getBoundingClientRect().width - panel.getBoundingClientRect().width) < 1, 'project content should follow the width during dragging');
  window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 21, clientX: dragStart + 80 }));
  await until(() => panel.getBoundingClientRect().width >= initialWidth + 95, 'pointer expands projects');
  const savedWidth = Number(localStorage.getItem('workbench.projectsSidebarWidth'));
  verifyFrameBounds();

  const cancelStart = beginDrag(22);
  window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 22, clientX: cancelStart + 60 }));
  await pause(30);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await until(() => Math.abs(panel.getBoundingClientRect().width - savedWidth) < 1, 'Escape restores the previous project width');
  expect(Number(localStorage.getItem('workbench.projectsSidebarWidth')) === savedWidth, 'cancelled resizing should preserve the saved width');

  resizer.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await until(() => Math.abs(panel.getBoundingClientRect().width - initialWidth) < 1, 'double click restores the default project width');
  const collapseStart = beginDrag(23);
  window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 23, clientX: collapseStart - 180 }));
  window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 23, clientX: collapseStart - 180 }));
  await until(() => panel.inert && panel.getBoundingClientRect().width < 1, 'dragging to the edge collapses projects');
  expect(historyVisible('ordinary'), 'resizing and collapsing should preserve the current conversation');
  click('#projects-sidebar-toggle');
  await until(() => !panel.inert && Math.abs(panel.getBoundingClientRect().width - initialWidth) < 1, 'reopen restores the saved project width');
}

async function runRegression() {
  await until(() => historyVisible("ordinary"), "initial ordinary history");
  expect(listReads === 0, "startup should not scan the project list");
  expect(document.querySelector('#projects-panel')?.getAttribute('aria-hidden') === 'true', 'ordinary I view should start with the project list closed');
  const shellStyle = getComputedStyle(document.documentElement);
  const navigationWidth = parseFloat(shellStyle.getPropertyValue('--project-navigation-width'));
  const frameGap = parseFloat(shellStyle.getPropertyValue('--workbench-frame-gap'));
  expect(document.querySelector('.project-navigation')!.getBoundingClientRect().width === navigationWidth + frameGap, 'the navigation should span the shell through the frame edge');
  expect(!document.querySelector(".composer-project-row"), "Composer project row should be removed");
  expect(document.querySelectorAll(".project-navigation button").length === 3, "navigation should contain I, Project and the Settings icon");
  click('.project-navigation [aria-label="Project"]');
  await until(() => !!document.querySelector(".projects-panel-error"), "first project load failure");
  expect(listReads === 1, "first open should issue one list read");
  delayNextListRead = 80;
  click(".projects-panel-error button");
  click('.project-navigation [aria-label="Project"]');
  click('.project-navigation [aria-label="Project"]');
  await until(() => !!document.querySelector('[data-project-id="alpha"]'), "project list");
  expect(listReads === 2, "opening while a list read is pending should reuse its request");
  expect(historyVisible("ordinary"), "browsing projects should preserve ordinary history");
  const background = getComputedStyle(document.querySelector(".projects-panel")!).backgroundColor;
  expect(background === getComputedStyle(document.querySelector(".workbench-frame")!).backgroundColor, "project list should share the raised frame surface");
  const icon = document.querySelector<SVGSVGElement>(".project-navigation-brand")!;
  expect(icon.tagName.toLowerCase() === "svg" && !!icon.querySelector("path") && !icon.querySelector("rect"), "navigation should show the symbol without its background tile");
  const panel = document.querySelector<HTMLElement>("#projects-panel")!;
  const listContent = document.querySelector<HTMLElement>(".projects-panel-content")!;
  listContent.style.maxHeight = "40px";
  listContent.scrollTop = 20;
  const scrollPosition = listContent.scrollTop;
  document.querySelector<HTMLButtonElement>('[aria-label="Hide projects"]')!.focus();
  click('[aria-label="Hide projects"]');
  await until(() => panel.inert && panel.getAttribute("aria-hidden") === "true", "folded project list");
  await until(() => panel.getBoundingClientRect().width < 1, "folded project column releases its width");
  expect(getComputedStyle(panel).visibility === "hidden", "the collapsed panel should leave native drag hit regions as well as keyboard navigation");
  expect(document.activeElement?.id === "projects-sidebar-toggle", "closing should retain focus on the visible sidebar toggle");
  const persistentToggle = document.querySelector<HTMLButtonElement>('#projects-sidebar-toggle[aria-label="Show projects"]')!;
  expect(persistentToggle && !persistentToggle.disabled && persistentToggle.getBoundingClientRect().width > 0, "the collapsed list should retain a visible reopen button");
  click('#projects-sidebar-toggle');
  await until(() => panel.getAttribute("aria-hidden") === "false", "reopened cached project list");
  await until(() => panel.classList.contains('phase-open'), "reopened project width settles");
  expect(document.querySelector(".projects-panel-content") === listContent && listContent.scrollTop === scrollPosition, "folding should preserve the list and its scroll position");
  expect(listReads === 2, "reopening a loaded list should use its snapshot");
  const selectedNavigation = document.querySelector<HTMLElement>('.project-navigation [aria-current="page"]')!;
  const headerToggle = document.querySelector<HTMLElement>('#projects-sidebar-toggle')!;
  expect(getComputedStyle(selectedNavigation).backgroundColor === getComputedStyle(headerToggle).backgroundColor, "navigation selection should share the toggle's light background");
  expect(document.querySelectorAll('#projects-sidebar-toggle').length === 1, "one toggle should move between the frame toolbar and project header");
  expect(getComputedStyle(document.querySelector('.workbench-frame')!).borderTopWidth === '1px', "the inner workspace should have its own boundary");
  listContent.style.maxHeight = "";
  await verifyProjectsResize(panel);
  const originalOrder = projectOrder().join();
  const addButton = document.querySelector<HTMLElement>('[aria-label="Add project"]')!;
  const rect = addButton.getBoundingClientRect();
  expect(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("button") === addButton, "Add must remain clickable above the window drag layer");
  const toggleRect = document.querySelector('#projects-sidebar-toggle')!.getBoundingClientRect();
  expect(toggleRect.left >= rect.right, "the expanded project toggle should sit to the right of Add");
  verifyFrameBounds();

  click('[aria-label="Show canvas"]');
  await until(() => !!document.querySelector("[data-canvas-scope]"), "Canvas lifecycle boundary");
  const beforeActivate = canvasOperations.length;
  click('[data-project-id="alpha"]');
  await until(() => historyVisible("alpha"), "selected project history");
  expect(projectOrder().join() === originalOrder, "activating a project should preserve its list position");
  expect(canvasOperations.slice(beforeActivate).indexOf("flush") < canvasOperations.slice(beforeActivate).indexOf("activate:alpha"), "Canvas flush should precede project activation");
  const afterFirst = historyReads.length;
  click('[data-project-id="alpha"]');
  await pause(40);
  expect(historyReads.length === afterFirst, "reselecting an active project should preserve loaded history");
  expect(pickerCalls === 0, "selecting a registered project should not open the folder picker");
  expect(listReads === 2, "project activation should keep the current list snapshot");

  click('[aria-label="Add project"]');
  await until(() => historyVisible("added") && !!document.querySelector('[data-project-id="added"]'), "added project history");
  expect(listReads === 3, "adding should refresh the project list once");
  picker = "cancel";
  const beforeCancel = historyReads.length;
  click('[aria-label="Add project"]');
  await pause(50);
  expect(historyVisible("added") && historyReads.length === beforeCancel, "picker cancellation should preserve the current scope and history");

  failingProject = "beta";
  click('[data-project-id="beta"]');
  await until(() => !!document.querySelector(".projects-panel-error"), "activation error");
  expect(historyVisible("added"), "failed activation should preserve the current conversation");
  failingProject = null;
  click(".projects-panel-error button");
  await until(() => historyVisible("beta"), "retry activation");

  delayedScope = "alpha";
  click('[data-project-id="alpha"]');
  await until(() => active.projectId === "alpha" && !document.querySelector<HTMLButtonElement>('[data-project-id="beta"]')!.disabled, "first scope pending history");
  click('[data-project-id="beta"]');
  await until(() => historyVisible("beta"), "second scope history");
  await pause(240);
  expect(historyVisible("beta") && !historyVisible("alpha"), "late old history must not replace the selected project");

  const readsBeforeMetadata = historyReads.length;
  await openMenu("beta", "Pin");
  await until(() => projectOrder()[0] === "beta", "pinned project moves to the top");
  await openMenu("beta", "Unpin");
  await until(() => projectOrder()[0] === "alpha", "unpin restores stable order");
  await openMenu("beta", "Reveal in Finder");
  await until(() => projectActions.some((request) => request.action === "reveal"), "reveal callback");
  await openMenu("beta", "Rename session");
  await until(() => !!document.querySelector('[aria-label="Session name"]'), "rename input");
  const name = document.querySelector<HTMLInputElement>('[aria-label="Session name"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Design notes");
  name.dispatchEvent(new Event("input", { bubbles: true }));
  await until(() => name.value === "Design notes", "rename text");
  click('[aria-label="Save session name"]');
  await until(() => document.querySelector('[data-project-id="beta"]')?.textContent === "Design notes", "renamed project");
  expect(historyReads.length === readsBeforeMetadata && historyVisible("beta"), "metadata actions should retain loaded history");
  await openMenu("beta", "Delete session");
  await until(() => !document.querySelector<HTMLButtonElement>('[aria-label="Add project"]')!.disabled, "cancelled deletion");
  expect(historyVisible("beta") && projectOrder().includes("beta"), "cancel should retain project and history");
  confirmDelete = true;
  await openMenu("alpha", "Delete session");
  await until(() => !projectOrder().includes("alpha"), "delete inactive project");
  expect(historyVisible("beta") && historyReads.length === readsBeforeMetadata, "deleting another project should retain the current history");
  await openMenu("beta", "Delete session");
  await until(() => historyVisible("ordinary") && !projectOrder().includes("beta"), "delete active project restores ordinary history");

  // Begin a live run through the actual Composer to verify navigation locking.
  const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task"]')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "test live run");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await until(() => !document.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.disabled, "Composer ready");
  click('[aria-label="Send"]');
  await until(() => document.querySelector<HTMLButtonElement>('.project-navigation [aria-label="I"]')!.disabled, "running scope lock");
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Add project"]')!.disabled, "adding must be locked during a run");
  expect(!document.querySelector<HTMLButtonElement>('.project-navigation [aria-label="Project"]')!.disabled, "layout toggle should remain available during a run");
  click('[aria-label="Hide projects"]');
  await until(() => panel.inert, "fold during a live run");
  click('.project-navigation [aria-label="Project"]');
  await until(() => !panel.inert, "expand during a live run");
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Add project"]')!.disabled, "expanding should preserve the run scope lock");
  for (const listener of listeners) listener({ type: "runCompleted", runId: "live-run", status: "completed", turnCount: 0 });
  await until(() => !document.querySelector<HTMLButtonElement>('.project-navigation [aria-label="I"]')!.disabled, "finished scope unlocked");
  click('.project-navigation [aria-label="I"]');
  await until(() => historyVisible("ordinary") && panel.inert, "return to ordinary history");

  click('.project-navigation [aria-label="Project"]');
  await until(() => !!document.querySelector('[data-project-id="added"]'), "reopened project list");
  click('[data-project-id="added"]');
  await until(() => historyVisible("added"), "final project view");
  await pause(240);
  const main = document.querySelector<HTMLElement>(".workspace")!.getBoundingClientRect();
  expect(main.width >= 360, "message area should keep a usable width with both sidebars");
  expect(document.documentElement.scrollWidth <= window.innerWidth, "workspace should not overflow horizontally");
  verifyFrameBounds();
  expect(listReads === 3, "metadata actions and all subsequent navigation should reuse the loaded list");
  await verifyProjectSnapshotRaces();
  return { historyReads, pickerCalls, listReads, projectActions, canvasOperations, mainWidth: main.width, errors };
}

function measureLayout() {
  verifyFrameBounds();
  const main = document.querySelector<HTMLElement>(".workspace")!.getBoundingClientRect();
  return {
    viewportWidth: window.innerWidth,
    mainWidth: main.width,
    scrollWidth: document.documentElement.scrollWidth,
    sidebarHidden: document.querySelector("#right-sidebar")?.getAttribute("aria-hidden"),
  };
}

function verifyFrameBounds(): void {
  const frame = document.querySelector<HTMLElement>('.workbench-frame')!;
  const topbar = document.querySelector<HTMLElement>('.topbar')!;
  const frameBounds = frame.getBoundingClientRect();
  const headerBounds = topbar.getBoundingClientRect();
  const navigationBounds = document.querySelector('.project-navigation')!.getBoundingClientRect();
  const streamBounds = document.querySelector('.stream-scroll')!.getBoundingClientRect();
  const composerBounds = document.querySelector('.composer-inner')!.getBoundingClientRect();
  expect(topbar.parentElement === frame, "the toolbar should belong to the inner frame");
  expect(headerBounds.top >= frameBounds.top && headerBounds.bottom <= frameBounds.bottom, "the toolbar should stay within the raised panel");
  expect(Math.abs(frameBounds.left - navigationBounds.right) < 1 && frameBounds.right <= window.innerWidth - 7 && frameBounds.bottom <= window.innerHeight - 7, "the navigation should meet the inner frame and the frame should keep its outer margins");
  expect(frameBounds.top >= 7, "the frame should retain a narrow top margin");
  expect(streamBounds.top >= headerBounds.bottom && streamBounds.bottom <= frameBounds.bottom, "message scrolling should stay below the frame toolbar");
  expect(composerBounds.top >= frameBounds.top && composerBounds.bottom <= frameBounds.bottom, "the Composer should anchor inside the message pane");
  expect(frame.contains(document.querySelector('#projects-panel')) && frame.contains(document.querySelector('#right-sidebar')), "both side panels should belong to the same inner frame");
  expect(frame.contains(document.querySelector('#projects-sidebar-toggle')), "the sidebar toggle should stay inside the frame in either position");
  expect(getComputedStyle(frame).boxShadow !== 'none', "a soft shadow should lift the inner frame above the shell");
  expect(getComputedStyle(frame).backgroundColor !== getComputedStyle(document.querySelector('.project-navigation')!).backgroundColor, "the raised panel and outer shell should use distinct surfaces");
}

declare global { interface Window { runProjectNavigationRegression: typeof runRegression; measureProjectNavigationLayout: typeof measureLayout } }
window.runProjectNavigationRegression = runRegression;
window.measureProjectNavigationLayout = measureLayout;
