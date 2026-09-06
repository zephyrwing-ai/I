/**
 * Markdown 渲染冒烟测试：管道 = 结构解析（mdast）→ 标点规范化（mdast 级）→ 渲染。
 * 用 ReactDOMServer 无 DOM 渲染，断言 SSR 标记里的结构元素与规范化文本。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownText } from "../frontend/src/middle-column/message-stream/MarkdownText.tsx";

function render(text: string): string {
  return renderToStaticMarkup(createElement(MarkdownText, { className: "model-text", text }));
}

test("加粗与中文标点：全角转半角并补空格", () => {
  const html = render("**你好，世界**");
  assert.match(html, /<strong>你好, 世界<\/strong>/);
});

test("行内代码：结构内文本不改动（SSR 转义引号）", () => {
  const html = render('`"你好，世界"`');
  assert.ok(html.includes('<code>&quot;你好，世界&quot;</code>'), html);
});

test("围栏代码块：全角标点保持原样", () => {
  const html = render('```js\nconst s = "你好，世界";\n```');
  assert.ok(html.includes("你好，世界"), html);
  assert.ok(html.includes("const s"), html);
});

test("单个换行渲染为 <br>（remark-breaks）", () => {
  const html = render("你好\n世界");
  assert.ok(html.includes("<br/>"), html);
});

test("GFM 表格渲染为 table", () => {
  const html = render("| 时间 | 状态 |\n| --- | --- |\n| 凌晨 | 完成 |");
  assert.ok(html.includes("<table>"), html);
});

test("任务列表：复选框 + 文本规范化", () => {
  const html = render("- [x] 完成\n- [ ] 计划");
  assert.ok(html.includes('type="checkbox"'), html);
  assert.ok(html.includes("checked"), html);
});

test("链接：地址不改动 + 文字规范化 + 外链新窗口", () => {
  const html = render("[你好，世界](https://example.com)");
  assert.ok(html.includes('href="https://example.com"'), html);
  assert.ok(html.includes('target="_blank"'), html);
  assert.ok(html.includes('rel="noopener noreferrer"'), html);
  assert.ok(html.includes("你好, 世界"), html);
});

test("节点边界：逗号后接强调文本补空格（看到的是可见字符）", () => {
  const html = render("你好,**世界**");
  assert.ok(html.includes("你好, <strong>"), html);
});

test("纯英文文本短路：不改写不补空格", () => {
  const html = render("Hello, world");
  assert.ok(html.includes("Hello, world"), html);
});

test("词内标点保护：3.14 与 package.json 不被拆开", () => {
  const html = render("数值是 3.14，包名是 package.json");
  assert.ok(html.includes("3.14, 包名"), html);
  assert.ok(html.includes("package.json"), html);
});
