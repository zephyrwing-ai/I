import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OutputFileDescriptor } from "../../../../shell/shared/ipc.js";

interface BrowserGlobals {
  window?: PropertyDescriptor;
  localStorage?: PropertyDescriptor;
}

function installBrowserGlobals(): () => void {
  const original: BrowserGlobals = {
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
  };
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerWidth: 1_440,
      matchMedia: () => ({ matches: false }),
      agentAPI: {
        previewOutputFile: async () => { throw new Error("effects do not run during SSR"); },
        openOutputFile: async () => { throw new Error("no interaction during SSR"); },
      },
    },
  });

  return () => {
    if (original.window) Object.defineProperty(globalThis, "window", original.window);
    else Reflect.deleteProperty(globalThis, "window");
    if (original.localStorage) Object.defineProperty(globalThis, "localStorage", original.localStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  };
}

const restoreBrowserGlobals = installBrowserGlobals();
const { OutputSidebar } = await import("../../../../frontend/src/components/OutputSidebar.js");

test.after(() => restoreBrowserGlobals());

function file(patch: Partial<OutputFileDescriptor> = {}): OutputFileDescriptor {
  return {
    runId: "run-current",
    fileId: "file-first",
    name: "report.md",
    displayPath: "reports/report.md",
    operation: "created",
    mediaType: "text/markdown",
    byteSize: 1_536,
    updatedAt: "2026-09-08T08:00:00.000Z",
    ...patch,
  };
}

function renderSidebar(open: boolean, files: OutputFileDescriptor[]): string {
  return renderToStaticMarkup(createElement(OutputSidebar, {
    open,
    files,
    onOpenChange: () => undefined,
  }));
}

test("open OutputSidebar reserves the top action area and exposes current files", () => {
  const html = renderSidebar(true, [file(), file({
    fileId: "file-second",
    name: "preview.png",
    displayPath: "preview.png",
    operation: "updated",
    mediaType: "image/png",
    byteSize: 2_048,
  })]);

  assert.match(html, /<aside[^>]*id="output-sidebar"[^>]*phase-open[^>]*aria-hidden="false"/);
  assert.match(html, /role="separator"[^>]*tabindex="0"/);
  assert.match(html, /<div class="output-sidebar-header" aria-hidden="true"><\/div>/);
  assert.doesNotMatch(html, />Current run<|>Output files</);
  assert.equal(html.match(/role="option"/g)?.length, 2);
  assert.ok(html.includes("Created"), html);
  assert.ok(html.includes("Updated"), html);
});

test("closed OutputSidebar remains associated with the TopBar but is hidden and unfocusable", () => {
  const html = renderSidebar(false, [file()]);

  assert.match(html, /<aside[^>]*id="output-sidebar"[^>]*phase-closed[^>]*style="width:0"[^>]*aria-hidden="true"/);
  assert.match(html, /role="separator"[^>]*tabindex="-1"/);
});

test("OutputSidebar initially selects the first current file and exposes preview actions", () => {
  const html = renderSidebar(true, [
    file(),
    file({ fileId: "file-second", name: "notes.txt", displayPath: "notes.txt", byteSize: 42 }),
  ]);

  assert.match(html, /role="option" aria-selected="true" class="selected"[^>]*>[\s\S]*?report\.md/);
  assert.match(html, /role="option" aria-selected="false"[^>]*>[\s\S]*?notes\.txt/);
  assert.match(html, /<section class="output-preview" aria-label="File preview">/);
  assert.match(html, /<strong>report\.md<\/strong><span>1\.5 KB<\/span>/);
  assert.match(html, /aria-label="Refresh preview"/);
  assert.match(html, /aria-label="Open in system"/);
  assert.doesNotMatch(html, /Select a file to preview its content/);
});

test("empty OutputSidebar renders both list and preview guidance without file actions", () => {
  const html = renderSidebar(true, []);

  assert.doesNotMatch(html, />Current run<|>Output files</);
  assert.match(html, /No files generated for this task/);
  assert.match(html, /Select a file to preview its content/);
  assert.doesNotMatch(html, /role="option"/);
  assert.doesNotMatch(html, /aria-label="Refresh preview"/);
  assert.doesNotMatch(html, /aria-label="Open in system"/);
});
