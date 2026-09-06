import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/** 滑块长度钳制：最小 48px，最大 72px */
const THUMB_MIN = 48;
const THUMB_MAX = 72;
/** 滑块距窗口上/下缘各 2px（行程计算与拖拽换算共用） */
const GAP = 2;

/**
 * 消息流滚动区域 + 比例滑块（JS 自绘）。
 * 原生滚动条隐藏（scrollbar-width: none）；滑块长度按内容比例缩放，
 * 钳制在 48–72px（内容极长时收至 48px，内容很少时保持 72px 上限）；
 * 常显（玻璃质感胶囊见 message-stream.css），拖拽期间保持。
 */
export function StreamRegion({ scrollRef, children }: { scrollRef: { current: HTMLElement | null }; children: ReactNode }) {
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(THUMB_MIN);
  const [fraction, setFraction] = useState(0);
  const [scrollable, setScrollable] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startY: number; startTop: number } | null>(null);
  const thumbHeight = useRef(THUMB_MIN);

  const sync = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const viewport = element.clientHeight;
    const content = element.scrollHeight;
    const max = content - viewport;
    const canScroll = max > 1;
    setScrollable(canScroll);
    if (!canScroll) return;
    const ratio = viewport / content;
    const h = Math.min(THUMB_MAX, Math.max(THUMB_MIN, ratio * viewport));
    thumbHeight.current = h;
    setHeight(h);
    setFraction(element.scrollTop / max);
    setTop((element.scrollTop / max) * (viewport - h - GAP * 2) + GAP);
  }, [scrollRef]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.addEventListener("scroll", sync);
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    sync();
    return () => {
      element.removeEventListener("scroll", sync);
      observer.disconnect();
    };
  }, [scrollRef, sync]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const element = scrollRef.current;
    if (!element) return;
    drag.current = { startY: event.clientY, startTop: element.scrollTop };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const element = scrollRef.current;
    const state = drag.current;
    if (!element || !state) return;
    const max = element.scrollHeight - element.clientHeight;
    const track = element.clientHeight - thumbHeight.current - GAP * 2;
    element.scrollTop = state.startTop + ((event.clientY - state.startY) / track) * max;
  };
  const onPointerUp = (): void => {
    drag.current = null;
    setDragging(false);
  };

  return (
    <div className="stream-region">
      <main ref={scrollRef as React.RefObject<HTMLElement>} id="message-stream" className="stream-scroll">
        {children}
      </main>
      <div className="stream-scrollbar" aria-hidden={!scrollable}>
        <div
          className={`stream-scrollbar-thumb${dragging ? " is-dragging" : ""}`}
          style={{ top, height }}
          role="scrollbar"
          aria-controls="message-stream"
          aria-valuenow={Math.round(fraction * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onLostPointerCapture={onPointerUp}
        />
      </div>
    </div>
  );
}
