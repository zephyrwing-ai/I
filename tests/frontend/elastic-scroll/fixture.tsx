import { createRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { StreamRegion } from "../../../frontend/src/middle-column/message-stream/StreamScrollbar";
import "../../../frontend/src/middle-column/Column.css";
import "../../../frontend/src/middle-column/message-stream/message-stream.css";

const root = createRoot(document.getElementById("root")!);
let mountId = 0;
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const frames = async () => { await frame(); await frame(); };

function sample(scroll: HTMLElement) {
  const content = scroll.querySelector<HTMLElement>(".stream-content")!;
  const thumb = document.querySelector<HTMLElement>(".stream-scrollbar-thumb")!;
  const fill = thumb.querySelector<HTMLElement>(".stream-scrollbar-thumb-fill")!;
  const viewport = scroll.getBoundingClientRect();
  const fillBounds = fill.getBoundingClientRect();
  return {
    scrollHeight: scroll.scrollHeight,
    scrollTop: scroll.scrollTop,
    viewportHeight: scroll.clientHeight,
    offset: new DOMMatrixReadOnly(getComputedStyle(content).transform).m42,
    thumbTop: thumb.offsetTop,
    thumbHeight: thumb.offsetHeight,
    fillScale: new DOMMatrixReadOnly(getComputedStyle(fill).transform).m22,
    fillTopGap: fillBounds.top - viewport.top,
    fillBottomGap: viewport.bottom - fillBounds.bottom,
    disabled: thumb.getAttribute("aria-disabled"),
  };
}

async function mount(height: number, nested = false) {
  const scrollRef = createRef<HTMLElement>();
  flushSync(() => root.render(
    <StreamRegion key={++mountId} scrollRef={scrollRef}>
      <div id="fixture-content" style={{ height }}>
        {nested && <div id="nested-scroll" style={{ height: 100, overflowY: "auto" }}>
          <div style={{ height: 600 }}>Nested scrollable content</div>
        </div>}
      </div>
    </StreamRegion>,
  ));
  await frames();
  return scrollRef.current!;
}

async function wheel(scroll: HTMLElement, deltaY: number, target: HTMLElement = scroll) {
  const event = new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  await frames();
  return { ...sample(scroll), consumed: event.defaultPrevented };
}

/** 单帧等待版本：连续采样必须落在跟手上限（ELASTIC_TRACK_MAX = 200ms）内。 */
async function wheelQuick(scroll: HTMLElement, deltaY: number) {
  const event = new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true });
  scroll.dispatchEvent(event);
  await frame();
  return { ...sample(scroll), consumed: event.defaultPrevented };
}

/** 根据实际回弹进度接续输入，使交互测试适用于不同回弹速度。 */
async function halfwayThroughReturn(scroll: HTMLElement) {
  const halfway = Math.abs(sample(scroll).offset) / 2;
  for (let i = 0; i < 120; i += 1) {
    await frame();
    const current = sample(scroll);
    if (Math.abs(current.offset) <= halfway) return current;
  }
  throw new Error("Elastic scroll did not reach the middle of its return");
}

async function boundarySequence(delta: number) {
  const scroll = await mount(1200);
  if (delta > 0) scroll.scrollTo({ top: scroll.scrollHeight, behavior: "instant" });
  await frames();
  const baseline = sample(scroll);
  const samples = [];
  let lastInputAt = 0;
  for (let i = 0; i < 6; i += 1) {
    lastInputAt = performance.now();
    samples.push(await wheelQuick(scroll, delta));
  }
  return { scroll, baseline, samples, lastInputAt };
}

/** 持续越界输入超过跟手上限：位移应在 200ms 附近见顶，随后回落，滑块始终不变形。 */
async function sustainedSequence() {
  const scroll = await mount(1200);
  scroll.scrollTo({ top: scroll.scrollHeight, behavior: "instant" });
  await frames();
  const samples: { at: number; offset: number; fillScale: number }[] = [];
  const start = performance.now();
  while (performance.now() - start < 420) {
    const event = new WheelEvent("wheel", { deltaY: 40, bubbles: true, cancelable: true });
    scroll.dispatchEvent(event);
    await frame();
    const current = sample(scroll);
    samples.push({ at: performance.now() - start, offset: current.offset, fillScale: current.fillScale });
  }
  return samples;
}

async function runElasticScrollRegression() {
  const bottom = await boundarySequence(40);
  await delay(Math.max(0, 500 - (performance.now() - bottom.lastInputAt)));
  await frame();
  const settled = sample(bottom.scroll);
  const settledAfter = performance.now() - bottom.lastInputAt;

  const sustained = await sustainedSequence();

  const top = await boundarySequence(-40);
  await delay(250); // 手势间隔：回弹完成并重置跟手窗口，再接续输入
  await wheel(top.scroll, -40);
  const beforeResume = await halfwayThroughReturn(top.scroll);
  const resumed = await wheel(top.scroll, -8);
  const beforeReverse = await halfwayThroughReturn(top.scroll);
  const reversed = await wheel(top.scroll, 8);

  const remainderScroll = await mount(1200);
  remainderScroll.scrollTo({ top: remainderScroll.scrollHeight, behavior: "instant" });
  await frames();
  await wheel(remainderScroll, 40);
  await wheel(remainderScroll, 40);
  const remainder = await wheel(remainderScroll, -100);

  const short = await mount(120);
  const shortSamples = [];
  for (const delta of [-40, -40, 40, 40, 40]) shortSamples.push(await wheel(short, delta));

  const resized = await mount(1200);
  resized.scrollTo({ top: resized.scrollHeight, behavior: "instant" });
  await frames();
  document.getElementById("fixture-content")!.style.height = "120px";
  await frames();
  await frames();
  const shortened = sample(resized);

  const nested = await mount(1200, true);
  const nestedScroll = document.getElementById("nested-scroll")!;
  nestedScroll.scrollTop = 50;
  const nestedSamples = [await wheel(nested, -40, nestedScroll), await wheel(nested, 40, nestedScroll)];

  const touchScroll = await mount(1200);
  const touch = (clientY: number) => new Touch({ identifier: 1, target: touchScroll, clientY });
  touchScroll.dispatchEvent(new TouchEvent("touchstart", { touches: [touch(100)], bubbles: true }));
  touchScroll.dispatchEvent(new TouchEvent("touchmove", { touches: [touch(140)], bubbles: true, cancelable: true }));
  await frames();
  const touchStarted = sample(touchScroll);
  await delay(150);
  const touchHeld = sample(touchScroll);
  touchScroll.dispatchEvent(new TouchEvent("touchend", { touches: [], bubbles: true }));
  await delay(500);
  await frame();
  const touchEnded = sample(touchScroll);

  root.unmount();
  return {
    bottom: { baseline: bottom.baseline, samples: bottom.samples, settled, settledAfter },
    sustained,
    top: { baseline: top.baseline, samples: top.samples },
    returning: { beforeResume, resumed, beforeReverse, reversed },
    remainder,
    shortSamples,
    shortened,
    nestedSamples,
    touch: { started: touchStarted, held: touchHeld, ended: touchEnded },
  };
}

Object.assign(window, { runElasticScrollRegression });
