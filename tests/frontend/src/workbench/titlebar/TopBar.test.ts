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
    outputOpen: false,
    outputCount: 0,
    searchOpen: false,
    searchButtonRef: createRef<HTMLButtonElement>(),
    onOutput: () => undefined,
    onSearch: () => undefined,
    ...patch,
  }));
}

test("TopBar keeps the project toggle visible alongside the three workbench actions", () => {
  const html = renderTopBar();

  assert.match(html, /<h1 class="sr-only">I<\/h1>/);
  assert.equal(html.match(/<button/g)?.length, 4);
  assert.match(html, /id="projects-sidebar-toggle"[^>]*aria-label="Show projects"[^>]*aria-expanded="false"[^>]*aria-controls="projects-panel"/);
  assert.match(html, /aria-label="Show output files"[^>]*aria-expanded="false"[^>]*aria-controls="right-sidebar"/);
  assert.match(html, /d="M16 6v12"/);
  assert.match(html, /aria-label="Show canvas"[^>]*aria-expanded="false"[^>]*aria-controls="right-sidebar"/);
  assert.match(html, /aria-label="Search all content"[^>]*aria-expanded="false"[^>]*aria-controls="search-popover"/);
});

test("TopBar leaves the expanded project toggle to the project header", () => {
  const html = renderTopBar({ projectsOpen: true });
  assert.equal(html.match(/<button/g)?.length, 3);
  assert.doesNotMatch(html, /id="projects-sidebar-toggle"/);
});

test("TopBar reflects open panels and hides the output badge while the sidebar is visible", () => {
  const html = renderTopBar({
    outputOpen: true,
    outputCount: 4,
    searchOpen: true,
  });

  assert.match(html, /class="icon-button active"[^>]*aria-label="Hide output files"[^>]*aria-expanded="true"/);
  assert.match(html, /d="M15 3v18"/);
  assert.equal(html.match(/class="icon-button active"/g)?.length, 2);
  assert.doesNotMatch(html, /class="icon-badge"/);
});

test("TopBar reports a bounded output count only when the sidebar is closed", () => {
  const exactCount = renderTopBar({ outputCount: 7 });
  const boundedCount = renderTopBar({ outputCount: 12 });

  assert.match(exactCount, /<span class="icon-badge">7<\/span>/);
  assert.match(boundedCount, /<span class="icon-badge">9\+<\/span>/);
});
