import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { copyMessageText, formatMessageTime, MessageMeta } from "../../../../../frontend/src/middle-column/message-stream/MessageMeta.js";

test("message copy writes the exact text supplied by its caller", async () => {
  const copied: string[] = [];
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async (text: string) => void copied.push(text) } },
  });

  try {
    const source = "**原始内容**，保留标记";
    await copyMessageText(source);
    assert.deepEqual(copied, [source]);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("message meta renders the copy action with its default accessible label", () => {
  const html = renderToStaticMarkup(createElement(MessageMeta, { time: 0, text: "内容" }));
  assert.match(html, /aria-label="Copy message"/);
});

test("message time uses the short English date format without commas", () => {
  const timestamp = new Date(2026, 8, 17, 11, 45).getTime();
  assert.equal(formatMessageTime(timestamp), "Thu Sep 17 11:45 AM");
});
