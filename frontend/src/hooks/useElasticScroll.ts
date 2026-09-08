import { useCallback, useEffect, useRef, type RefObject } from "react";

/** 视觉位移上限与拉力达到半幅时的像素数。 */
export const ELASTIC_MAX = 96;
export const ELASTIC_SATURATION = 400;
export const ELASTIC_OMEGA = 28;
export const ELASTIC_ZETA = 0.9;
/** wheel 静默后进入回弹；触摸以抬起作为回弹起点。 */
export const ELASTIC_WHEEL_IDLE = 80;

type ElasticPhase = "idle" | "tracking" | "returning";

export function offsetFromPull(pull: number, saturation: number, max: number, sign: number): number {
  return sign * max * (1 - 1 / (pull / saturation + 1));
}

export function pullFromOffset(offset: number, saturation: number, max: number): number {
  const magnitude = Math.min(Math.abs(offset), max - 0.01);
  return saturation * (max / (max - magnitude) - 1);
}

/** 欠阻尼弹簧的解析步进；按真实经过时间推进，使不同刷新率共用一条运动曲线。 */
export function springStep(x: number, v: number, dt: number, omega: number, zeta: number): readonly [number, number] {
  const decay = zeta * omega;
  const frequency = omega * Math.sqrt(1 - zeta * zeta);
  const envelope = Math.exp(-decay * dt);
  const sin = Math.sin(frequency * dt);
  const cos = Math.cos(frequency * dt);
  return [
    envelope * (x * cos + ((v + decay * x) / frequency) * sin),
    envelope * (v * cos - ((decay * v + omega * omega * x) / frequency) * sin),
  ];
}

export type BoundaryKind = "outward" | "inland" | "within";

export function boundaryKind(top: number, max: number, delta: number): BoundaryKind {
  if (delta === 0) return "within";
  if (max <= 1) return "outward";
  const atTop = top <= 0.5;
  const atBottom = top >= max - 0.5;
  if ((delta < 0 && atTop) || (delta > 0 && atBottom)) return "outward";
  return atTop || atBottom ? "inland" : "within";
}

/** 内部代码块、工具输出等滚动区优先消耗自身方向上的滚动余量。 */
function nestedCanScroll(target: EventTarget | null, container: HTMLElement, delta: number): boolean {
  let node = target instanceof Element ? target : null;
  while (node && node !== container) {
    const max = node.scrollHeight - node.clientHeight;
    if (max > 1 && /^(auto|scroll)$/.test(getComputedStyle(node).overflowY)) {
      if ((delta < 0 && node.scrollTop > 0.5) || (delta > 0 && node.scrollTop < max - 0.5)) return true;
    }
    node = node.parentElement;
  }
  return false;
}

/**
 * 容器提供稳定的滚动几何，contentRef 位于布局裁剪层内并负责弹性位移。
 * 单一动画帧同步写入内容位移与可选滑块填充层的缩放、透明度。
 */
export function useElasticScroll(
  scrollRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  thumbRef?: RefObject<HTMLElement | null>,
): () => void {
  const resetRef = useRef<() => void>(() => {});
  const reset = useCallback(() => resetRef.current(), []);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    const thumb = thumbRef?.current;
    if (!el || !content) return;

    let phase: ElasticPhase = "idle";
    let pull = 0; // 视觉方向：顶部为正，底部为负；反向输入先抵消已有拉力。
    let offset = 0;
    let velocity = 0;
    let lastFrame = 0;
    let frameId = 0;
    let idleTimerId = 0;
    let touchLastY: number | null = null;
    let origin = "top";
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const paint = (): void => {
      content.style.transform = offset === 0 ? "" : `translateY(${offset}px)`;
      if (thumb) {
        const scale = 1 - 0.4 * Math.min(Math.abs(offset) / ELASTIC_MAX, 1);
        thumb.style.transformOrigin = origin;
        thumb.style.transform = offset === 0 ? "" : `scaleY(${scale})`;
        thumb.style.opacity = String(scale);
      }
    };
    const rest = (): void => {
      clearTimeout(idleTimerId);
      phase = "idle";
      pull = 0;
      offset = 0;
      velocity = 0;
    };
    const frame = (now: number): void => {
      frameId = 0;
      if (phase === "returning") {
        [offset, velocity] = springStep(offset, velocity, Math.max(0, now - lastFrame) / 1000, ELASTIC_OMEGA, ELASTIC_ZETA);
        lastFrame = now;
        if (Math.abs(offset) < 0.3 && Math.abs(velocity) < 5) rest();
      }
      paint();
      if (phase === "returning") frameId = requestAnimationFrame(frame);
    };
    const schedule = (): void => {
      if (!frameId) frameId = requestAnimationFrame(frame);
    };
    const resetMotion = (): void => {
      cancelAnimationFrame(frameId);
      frameId = 0;
      rest();
      paint();
    };
    resetRef.current = resetMotion;
    const startReturning = (): void => {
      if (phase !== "tracking") return;
      clearTimeout(idleTimerId);
      phase = "returning";
      velocity = 0;
      lastFrame = performance.now();
      schedule();
    };

    const consume = (delta: number, event: Event, wheel: boolean): void => {
      if (delta === 0 || !event.cancelable || event.defaultPrevented || reducedMotion.matches) return;
      if (nestedCanScroll(event.target, el, delta)) return;
      const scrollMax = el.scrollHeight - el.clientHeight;
      const kind = boundaryKind(el.scrollTop, scrollMax, delta);
      if (phase === "idle" && kind !== "outward") return;
      // 内容增长后，原生滚动接续新增空间，已有视觉位移继续平滑回弹。
      if (kind === "within") {
        startReturning();
        return;
      }
      if (phase === "returning") {
        pull = Math.sign(offset) * pullFromOffset(offset, ELASTIC_SATURATION, ELASTIC_MAX);
      }
      const nextPull = pull - delta;
      event.preventDefault();
      clearTimeout(idleTimerId);
      if (scrollMax > 1 && pull !== 0 && Math.sign(nextPull) !== Math.sign(pull)) {
        const remainder = delta - pull;
        rest();
        el.scrollTo({ top: el.scrollTop + remainder, behavior: "instant" });
      } else if (nextPull === 0) {
        rest();
      } else {
        pull = nextPull;
        offset = offsetFromPull(Math.abs(pull), ELASTIC_SATURATION, ELASTIC_MAX, Math.sign(pull));
        origin = pull < 0 && scrollMax > 1 ? "bottom" : "top";
        velocity = 0;
        phase = "tracking";
        if (wheel) idleTimerId = window.setTimeout(startReturning, ELASTIC_WHEEL_IDLE);
      }
      schedule();
    };
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? el.clientHeight
        : event.deltaMode === WheelEvent.DOM_DELTA_LINE ? parseFloat(getComputedStyle(el).lineHeight) || 16 : 1;
      consume(event.deltaY * unit, event, true);
    };
    const onTouchStart = (event: TouchEvent): void => {
      touchLastY = event.touches.length === 1 ? event.touches.item(0)!.clientY : null;
      if (touchLastY !== null && phase === "returning") {
        pull = Math.sign(offset) * pullFromOffset(offset, ELASTIC_SATURATION, ELASTIC_MAX);
        phase = "tracking";
        velocity = 0;
      }
      clearTimeout(idleTimerId);
    };
    const onTouchMove = (event: TouchEvent): void => {
      const touch = event.touches.length === 1 ? event.touches.item(0) : null;
      if (!touch || touchLastY === null) return;
      const delta = touchLastY - touch.clientY;
      touchLastY = touch.clientY;
      consume(delta, event, false);
    };
    const onTouchEnd = (): void => {
      touchLastY = null;
      startReturning();
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    reducedMotion.addEventListener("change", resetMotion);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      reducedMotion.removeEventListener("change", resetMotion);
      resetMotion();
      resetRef.current = () => {};
    };
  }, [scrollRef, contentRef, thumbRef]);

  return reset;
}
