import assert from "node:assert/strict";
import test from "node:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchPopover } from "../../../../../../frontend/src/workbench/titlebar/search/SearchPopover.js";
import type { SearchResult } from "../../../../../../frontend/src/workbench/titlebar/search/search.js";

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
