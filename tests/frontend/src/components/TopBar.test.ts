import assert from "node:assert/strict";
import test from "node:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchPopover, TopBar } from "../../../../frontend/src/components/TopBar.js";
import type { SearchResult } from "../../../../frontend/src/store/search.js";

function renderTopBar(patch: Partial<Parameters<typeof TopBar>[0]> = {}): string {
  return renderToStaticMarkup(createElement(TopBar, {
    outputOpen: false,
    outputCount: 0,
    searchOpen: false,
    settingsOpen: false,
    searchButtonRef: createRef<HTMLButtonElement>(),
    settingsButtonRef: createRef<HTMLButtonElement>(),
    onOutput: () => undefined,
    onSearch: () => undefined,
    onSettings: () => undefined,
    ...patch,
  }));
}

test("TopBar exposes the workbench heading and three named actions", () => {
  const html = renderTopBar();

  assert.match(html, /<h1 class="sr-only">Agent Workbench<\/h1>/);
  assert.equal(html.match(/<button/g)?.length, 3);
  assert.match(html, /aria-label="Show output files"[^>]*aria-expanded="false"[^>]*aria-controls="output-sidebar"/);
  assert.match(html, /d="M16 6v12"/);
  assert.match(html, /aria-label="Search all content"[^>]*aria-expanded="false"[^>]*aria-controls="search-popover"/);
  assert.match(html, /aria-label="Settings"[^>]*aria-expanded="false"/);
});

test("TopBar reflects open panels and hides the output badge while the sidebar is visible", () => {
  const html = renderTopBar({
    outputOpen: true,
    outputCount: 4,
    searchOpen: true,
    settingsOpen: true,
  });

  assert.match(html, /class="icon-button active"[^>]*aria-label="Hide output files"[^>]*aria-expanded="true"/);
  assert.match(html, /d="M15 3v18"/);
  assert.equal(html.match(/class="icon-button active"/g)?.length, 3);
  assert.doesNotMatch(html, /class="icon-badge"/);
});

test("TopBar reports a bounded output count only when the sidebar is closed", () => {
  const exactCount = renderTopBar({ outputCount: 7 });
  const boundedCount = renderTopBar({ outputCount: 12 });

  assert.match(exactCount, /<span class="icon-badge">7<\/span>/);
  assert.match(boundedCount, /<span class="icon-badge">9\+<\/span>/);
});

test("SearchPopover renders a labelled controlled search dialog", () => {
  const html = renderToStaticMarkup(createElement(SearchPopover, {
    query: "输出",
    onQueryChange: () => undefined,
    results: [],
    activeBlockId: null,
    loadingHistory: false,
    hydrated: true,
    hasMoreHistory: false,
    error: null,
    panelRef: createRef<HTMLDivElement>(),
    onSelect: () => undefined,
    onRetry: () => undefined,
  }));

  assert.match(html, /role="dialog" aria-label="Search all content"/);
  assert.match(html, /<input[^>]*value="输出"/);
  assert.match(html, /placeholder="Search\.\.\."/);
  assert.match(html, /aria-label="Search content"/);
  assert.match(html, /<span class="search-glyph"><svg[^>]*stroke-width="2"/);
});

test("SearchPopover renders one uniform result row and highlights its first match", () => {
  const result: SearchResult = {
    blockId: "run-1:task",
    text: "之前的你好消息",
    snippet: "…的你好消息…",
    matchRange: { start: 3, end: 5 },
    snippetMatchRange: { start: 2, end: 4 },
  };
  const html = renderToStaticMarkup(createElement(SearchPopover, {
    query: "你好",
    onQueryChange: () => undefined,
    results: [result],
    activeBlockId: result.blockId,
    loadingHistory: false,
    hydrated: true,
    hasMoreHistory: false,
    error: null,
    panelRef: createRef<HTMLDivElement>(),
    onSelect: () => undefined,
    onRetry: () => undefined,
  }));

  assert.equal(html.match(/role="option"/g)?.length, 1);
  assert.match(html, /class="search-result"/);
  assert.match(html, /class="search-result-marker"/);
  assert.match(html, /<mark>你好<\/mark>/);
  assert.doesNotMatch(html, /来源|用户消息|模型消息/);
});
