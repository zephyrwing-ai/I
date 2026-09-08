import assert from "node:assert/strict";
import test from "node:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchPopover, TopBar } from "../../../../frontend/src/components/TopBar.js";

function renderTopBar(patch: Partial<Parameters<typeof TopBar>[0]> = {}): string {
  return renderToStaticMarkup(createElement(TopBar, {
    outputOpen: false,
    outputCount: 0,
    searchOpen: false,
    settingsOpen: false,
    settingsButtonRef: createRef<HTMLButtonElement>(),
    onOutput: () => undefined,
    onSearch: () => undefined,
    onSettings: () => undefined,
    ...patch,
  }));
}

test("TopBar exposes the workbench heading and three named actions", () => {
  const html = renderTopBar();

  assert.match(html, /<h1 class="sr-only">主工作台<\/h1>/);
  assert.equal(html.match(/<button/g)?.length, 3);
  assert.match(html, /aria-label="显示输出文件"[^>]*aria-expanded="false"[^>]*aria-controls="output-sidebar"/);
  assert.match(html, /aria-label="搜索全局内容"/);
  assert.match(html, /aria-label="设置"[^>]*aria-expanded="false"/);
});

test("TopBar reflects open panels and hides the output badge while the sidebar is visible", () => {
  const html = renderTopBar({
    outputOpen: true,
    outputCount: 4,
    searchOpen: true,
    settingsOpen: true,
  });

  assert.match(html, /class="icon-button active"[^>]*aria-label="隐藏输出文件"[^>]*aria-expanded="true"/);
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
    query: "命令 <输出>",
    onQueryChange: () => undefined,
  }));

  assert.match(html, /role="dialog" aria-label="搜索全局内容"/);
  assert.match(html, /<input[^>]*value="命令 &lt;输出&gt;"/);
  assert.match(html, /placeholder="搜索任务、命令或输出…"/);
  assert.match(html, /aria-label="搜索内容"/);
});
