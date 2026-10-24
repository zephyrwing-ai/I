import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

register("../../../css-module-loader.mjs", import.meta.url);

const browserGlobals = new Map(["window", "localStorage"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const preferences = new Map<string, string>();
Object.defineProperties(globalThis, {
  window: { configurable: true, value: { innerWidth: 1440, matchMedia: () => ({ matches: false }) } },
  localStorage: { configurable: true, value: { getItem: (key: string) => preferences.get(key) ?? null, setItem: (key: string, value: string) => preferences.set(key, value) } },
});
test.after(() => {
  for (const [key, descriptor] of browserGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const { ProjectsPanel } = await import("../../../../../frontend/src/workbench/project/ProjectsPanel.js");

test("projects panel identifies duplicate names by project ID and places Add project in its header", () => {
  const html = renderToStaticMarkup(createElement(ProjectsPanel, {
    open: true, onToggle: () => undefined, onOpenChange: () => undefined,
    projects: [
      { projectId: "a", displayName: "I", canonicalPath: "/work/a/I" },
      { projectId: "b", displayName: "I", canonicalPath: "/work/b/I" },
    ],
    activeProjectId: "b", loading: false, error: null,
    onAdd: () => undefined, onSelect: () => undefined, onRetry: () => undefined,
    onAction: async () => undefined,
  }));
  assert.match(html, /<header[^>]*>.*aria-label="Add project".*<\/header>/);
  assert.match(html, /data-project-id="b" aria-current="page"/);
  assert.match(html, /title="\/work\/a\/I"/);
  assert.match(html, /title="\/work\/b\/I"/);
  assert.ok(html.indexOf('aria-label="Add project"') < html.indexOf('aria-label="Hide projects"'));
});

test("project loading errors retain existing entries and offer a retry", () => {
  const html = renderToStaticMarkup(createElement(ProjectsPanel, {
    open: true, onToggle: () => undefined, onOpenChange: () => undefined,
    projects: [{ projectId: "a", displayName: "I", canonicalPath: "/work/I" }],
    activeProjectId: "a", loading: false, error: "Directory unavailable", disabled: true,
    onAdd: () => undefined, onSelect: () => undefined, onRetry: () => undefined,
    onAction: async () => undefined,
  }));
  assert.match(html, /role="alert"/);
  assert.match(html, /Try again/);
  assert.match(html, /data-project-id="a"/);
  assert.equal(html.match(/disabled=""/g)?.length, 3);
});
