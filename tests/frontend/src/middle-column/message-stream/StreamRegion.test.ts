import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { StreamRegion } = await import("../../../../../frontend/src/middle-column/message-stream/StreamScrollbar.js");

test("StreamRegion 画布结构：滚动容器内含 stream-content 包裹层（弹性位移目标）与右侧滚动条", () => {
  const html = renderToStaticMarkup(
    createElement(StreamRegion, {
      scrollRef: { current: null },
      children: createElement("div", null, "内容"),
    }),
  );

  const main = html.match(/<main(?=[^>]*id="message-stream")[^>]*>/)?.[0];
  assert.ok(main, "存在消息流滚动容器 main");
  assert.match(main, /class="stream-scroll"/, "滚动容器使用 stream-scroll 类");
  assert.ok(html.indexOf("stream-content") > html.indexOf("message-stream"), "stream-content 位于滚动容器内");
  assert.match(html, /class="stream-scrollbar"/, "右侧滚动条存在");
  assert.match(html, /class="stream-layout"/, "布局裁剪层包裹动画内容");
  assert.match(html, /class="stream-scrollbar-thumb-fill"/, "滑块填充层承载玻璃质感外观");
  assert.match(html, /aria-disabled="true"/, "短内容的滑块保持可见并标记滚动状态");
});
