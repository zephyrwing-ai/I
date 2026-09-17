import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { useElasticScroll } from "../../hooks/useElasticScroll";

const THUMB_MIN = 48;
const THUMB_MAX = 72;
const GAP = 2;

/** 布局层稳定滚动范围，内容层呈现位移，滑块填充层呈现压缩。 */
export function StreamRegion({ scrollRef, children }: { scrollRef: RefObject<HTMLElement>; children: ReactNode }) {
  const [geometry, setGeometry] = useState({ top: GAP, height: THUMB_MAX, fraction: 0, scrollable: false });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startY: number; startTop: number } | null>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const resetElastic = useElasticScroll(scrollRef, contentRef);

  const sync = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const viewport = element.clientHeight;
    const max = element.scrollHeight - viewport;
    const scrollable = max > 1;
    const height = Math.min(THUMB_MAX, Math.max(THUMB_MIN, viewport * viewport / Math.max(element.scrollHeight, 1)));
    const fraction = scrollable ? Math.max(0, Math.min(1, element.scrollTop / max)) : 0;
    const top = fraction * Math.max(0, viewport - height - GAP * 2) + GAP;
    setGeometry((current) => current.top === top && current.height === height && current.fraction === fraction && current.scrollable === scrollable
      ? current : { top, height, fraction, scrollable });
  }, [scrollRef]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.addEventListener("scroll", sync, { passive: true });
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    if (layoutRef.current) observer.observe(layoutRef.current);
    sync();
    return () => {
      element.removeEventListener("scroll", sync);
      observer.disconnect();
    };
  }, [scrollRef, sync]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    const element = scrollRef.current;
    if (!element || !geometry.scrollable || event.button !== 0) return;
    event.preventDefault();
    resetElastic();
    drag.current = { startY: event.clientY, startTop: element.scrollTop };
    setDragging(true);
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const element = scrollRef.current;
    const state = drag.current;
    if (!element || !state) return;
    const max = element.scrollHeight - element.clientHeight;
    const track = element.clientHeight - geometry.height - GAP * 2;
    if (track <= 0 || max <= 1) return;
    element.scrollTo({ top: state.startTop + ((event.clientY - state.startY) / track) * max, behavior: "instant" });
  };
  const onPointerUp = (): void => {
    drag.current = null;
    setDragging(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const element = scrollRef.current;
    if (!element) return;
    const positions: Record<string, number> = {
      ArrowUp: element.scrollTop - 40,
      ArrowDown: element.scrollTop + 40,
      PageUp: element.scrollTop - element.clientHeight,
      PageDown: element.scrollTop + element.clientHeight,
      Home: 0,
      End: element.scrollHeight,
    };
    const top = positions[event.key];
    if (top === undefined) return;
    event.preventDefault();
    resetElastic();
    element.scrollTo({ top, behavior: "instant" });
  };

  return (
    <div className="stream-region">
      <main ref={scrollRef} id="message-stream" className="stream-scroll">
        <div ref={layoutRef} className="stream-layout">
          <div ref={contentRef} className="stream-content">{children}</div>
        </div>
      </main>
      <div className="stream-scrollbar">
        <div
          className={`stream-scrollbar-thumb${dragging ? " is-dragging" : ""}`}
          style={{ top: geometry.top, height: geometry.height }}
          role="scrollbar"
          tabIndex={0}
          aria-label="消息滚动位置"
          aria-orientation="vertical"
          aria-disabled={!geometry.scrollable}
          aria-controls="message-stream"
          aria-valuenow={Math.round(geometry.fraction * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onLostPointerCapture={onPointerUp}
        ><div className="stream-scrollbar-thumb-fill" /></div>
      </div>
    </div>
  );
}
