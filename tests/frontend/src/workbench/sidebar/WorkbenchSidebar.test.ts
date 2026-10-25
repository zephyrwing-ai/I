import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createElement, createRef, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { InputAttachmentDescriptor, OutputFileDescriptor, ProjectDescriptor } from "../../../../../shell/shared/ipc.js";
import type { SidebarAttachment } from "../../../../../frontend/src/workbench/sidebar/SidebarResources.js";

register("../../../css-module-loader.mjs", import.meta.url);

const project: ProjectDescriptor = {
  projectId: "project-a",
  displayName: "Research",
  canonicalPath: "/work/Research",
};
const ordinary: ProjectDescriptor = { projectId: null, displayName: "I", canonicalPath: null };
const originals = new Map(["window", "localStorage"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
Object.defineProperties(globalThis, {
  window: {
    configurable: true,
    value: {
      innerWidth: 1_440,
      matchMedia: () => ({ matches: false }),
      agentAPI: { listProjectDirectory: async () => ({ ok: false, error: "read_failed", message: "SSR" }) },
    },
  },
  localStorage: {
    configurable: true,
    value: { getItem: () => null, setItem: () => undefined },
  },
});

test.after(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const { WorkbenchSidebar } = await import("../../../../../frontend/src/workbench/sidebar/WorkbenchSidebar.js");

function render(
  descriptor: ProjectDescriptor,
  surface: "home" | "files" | "canvas" | "resource" | null,
  patch: {
    projectPending?: boolean;
    projectError?: string | null;
    canvas?: ReactNode;
    attachments?: SidebarAttachment[];
    files?: OutputFileDescriptor[];
  } = {},
): string {
  return renderToStaticMarkup(createElement(WorkbenchSidebar, {
    surface,
    onSurfaceChange: () => undefined,
    project: descriptor,
    projectMode: descriptor.projectId !== null,
    projectPending: patch.projectPending ?? false,
    projectError: patch.projectError ?? null,
    onRetryProject: () => undefined,
    onAddProject: () => undefined,
    onOpenProjectDirectory: async () => null,
    attachments: patch.attachments ?? [],
    files: patch.files ?? [],
    canvas: patch.canvas ?? createElement("div", { className: "canvas-test" }, "Canvas"),
    canvasCanRelease: true,
    workspaceRef: createRef<HTMLElement>(),
  }));
}

test("project launcher exposes workspace files and Canvas while ordinary I exposes the resource list", () => {
  const projectHtml = render(project, "home");
  assert.match(projectHtml, /Open workspace files/);
  assert.match(projectHtml, /Open canvas/);
  assert.doesNotMatch(projectHtml, /View All Outputs/);

  const ordinaryHtml = render(ordinary, "home");
  assert.doesNotMatch(ordinaryHtml, /Open workspace files/);
  assert.match(ordinaryHtml, /Open Canvas/);
  assert.match(ordinaryHtml, /View All Outputs/);
  assert.doesNotMatch(ordinaryHtml, />I</);
});

test("resource rows open an in-app preview and expose the original file action", () => {
  const attachment: InputAttachmentDescriptor = {
    attachmentId: "attachment-a",
    name: "brief.md",
    mediaType: "text/markdown",
    byteSize: 42,
  };
  const file: OutputFileDescriptor = {
    runId: "run-a",
    fileId: "file-a",
    name: "report.md",
    displayPath: "report.md",
    mediaType: "text/markdown",
    byteSize: 84,
    operation: "created",
    updatedAt: "2026-10-25T10:00:00.000Z",
  };
  const html = render(ordinary, "home", {
    attachments: [{ attachment, pending: false }],
    files: [file],
  });
  assert.match(html, /class="sidebar-resource-main"/);
  assert.match(html, /brief\.md/);
  assert.match(html, /report\.md/);
  assert.equal((html.match(/aria-label="Open original file"/g) ?? []).length, 2);
});

test("project transition and errors replace launcher actions with recoverable state", () => {
  const pending = render(project, "home", { projectPending: true });
  assert.match(pending, /Loading project…/);
  assert.doesNotMatch(pending, /Open workspace files/);

  const failed = render(project, "home", { projectError: "Directory unavailable" });
  assert.match(failed, /Directory unavailable/);
  assert.match(failed, /Try again/);
  assert.doesNotMatch(failed, /Open workspace files/);
});

test("closed sidebar and Canvas surface retain their render contracts", () => {
  const closed = render(project, null);
  assert.match(closed, /id="right-sidebar"[^>]*phase-closed[^>]*style="width:0"[^>]*aria-hidden="true"/);
  assert.match(closed, /role="separator"[^>]*tabindex="-1"/);

  const canvas = render(project, "canvas");
  assert.match(canvas, />Canvas</);
  assert.match(canvas, /class="canvas-test">Canvas/);
});
