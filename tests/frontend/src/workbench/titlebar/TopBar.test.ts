import assert from "node:assert/strict";
import test from "node:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TopBar } from "../../../../../frontend/src/workbench/titlebar/TopBar.js";

function renderTopBar(patch: Partial<Parameters<typeof TopBar>[0]> = {}): string {
  return renderToStaticMarkup(createElement(TopBar, {
    projectMode: true,
    projectsOpen: false,
    onProjects: () => undefined,
    sidebarOpen: false,
    searchOpen: false,
    searchButtonRef: createRef<HTMLButtonElement>(),
    onSidebar: () => undefined,
    onSearch: () => undefined,
    ...patch,
  }));
}

test("TopBar keeps the project toggle visible alongside the two workbench actions", () => {
  const html = renderTopBar();

  assert.match(html, /<h1 class="sr-only">I<\/h1>/);
  assert.equal(html.match(/<button/g)?.length, 3);
  assert.match(html, /id="projects-sidebar-toggle"[^>]*aria-label="Show projects"[^>]*aria-expanded="false"[^>]*aria-controls="projects-panel"/);
  assert.match(html, /title="Show sidebar" aria-label="Show sidebar"[^>]*aria-expanded="false"[^>]*aria-controls="right-sidebar"/);
  assert.match(html, /d="M16 6v12"/);
  assert.match(html, /aria-label="Search all content"[^>]*aria-expanded="false"[^>]*aria-controls="search-popover"/);
  assert.doesNotMatch(html, /icon-badge|Show canvas|Hide canvas/);
});

test("TopBar leaves the expanded project toggle to the project header", () => {
  const html = renderTopBar({ projectsOpen: true });
  assert.equal(html.match(/<button/g)?.length, 2);
  assert.doesNotMatch(html, /id="projects-sidebar-toggle"/);
});

for (const sidebarOpen of [false, true]) {
  for (const searchOpen of [false, true]) {
    test(`TopBar reflects sidebarOpen=${sidebarOpen} and searchOpen=${searchOpen} independently`, () => {
      const html = renderTopBar({ projectsOpen: true, sidebarOpen, searchOpen });
      const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
      assert.equal(buttons.length, 2);
      const [sidebarButton, searchButton] = buttons;

      assert.match(sidebarButton, new RegExp(`class="icon-button ${sidebarOpen ? "active" : ""}"`));
      assert.match(sidebarButton, new RegExp(`title="${sidebarOpen ? "Hide" : "Show"} sidebar" aria-label="${sidebarOpen ? "Hide" : "Show"} sidebar" aria-expanded="${sidebarOpen}" aria-controls="right-sidebar"`));
      const sidebarIcon = sidebarButton.match(/<svg\b[^>]*>/)?.[0] ?? "";
      assert.match(sidebarIcon, /\bwidth="18"/);
      assert.match(sidebarIcon, /\bheight="18"/);
      assert.match(sidebarIcon, /\bstroke-width="2"/);
      assert.match(sidebarButton, sidebarOpen ? /d="M15 3v18"/ : /d="M16 6v12"/);
      assert.match(searchButton, new RegExp(`class="icon-button ${searchOpen ? "active" : ""}"`));
      assert.match(searchButton, new RegExp(`aria-label="Search all content" aria-expanded="${searchOpen}" aria-controls="search-popover"`));
      assert.doesNotMatch(html, /icon-badge|Show canvas|Hide canvas/);
    });
  }
}
