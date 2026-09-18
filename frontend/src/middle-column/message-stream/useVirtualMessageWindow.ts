import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

export interface VirtualMessageItem {
  blockId: string;
  estimatedHeight: number;
}

export interface VirtualMessageLayoutItem extends VirtualMessageItem {
  index: number;
  start: number;
  size: number;
  end: number;
}

export interface VirtualMessageLayout {
  items: VirtualMessageLayoutItem[];
  totalSize: number;
}

export interface VirtualMessageRange {
  startIndex: number;
  endIndex: number;
  topSpacer: number;
  bottomSpacer: number;
}

const DEFAULT_VIEWPORT_HEIGHT = 800;
const DEFAULT_OVERSCAN = 600;
const LOAD_OLDER_THRESHOLD = 240;
const STICK_TO_BOTTOM_THRESHOLD = 24;

const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function findBlockNode(root: HTMLElement | null, blockId: string): HTMLElement | null {
  if (!root) return null;
  return Array.from(root.querySelectorAll<HTMLElement>("[data-message-block-id]"))
    .find((node) => node.dataset.messageBlockId === blockId) ?? null;
}

function centerBlock(element: HTMLElement, node: HTMLElement): void {
  const containerRect = element.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  const correction = nodeRect.top - containerRect.top - Math.max(0, (element.clientHeight - nodeRect.height) / 2);
  if (Math.abs(correction) < 1) return;
  const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  element.scrollTop = Math.min(maxScrollTop, Math.max(0, element.scrollTop + correction));
}

export function buildVirtualMessageLayout(
  items: VirtualMessageItem[],
  measuredHeights: ReadonlyMap<string, number>,
): VirtualMessageLayout {
  let start = 0;
  const layoutItems = items.map((item, index) => {
    const measured = measuredHeights.get(item.blockId);
    const size = measured !== undefined && measured > 0 ? measured : item.estimatedHeight;
    const layoutItem = { ...item, index, start, size, end: start + size };
    start += size;
    return layoutItem;
  });
  return { items: layoutItems, totalSize: start };
}

function firstItemEndingAfter(items: VirtualMessageLayoutItem[], offset: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (items[middle].end < offset) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, Math.max(0, items.length - 1));
}

function firstItemStartingAfter(items: VirtualMessageLayoutItem[], offset: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (items[middle].start <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function calculateVirtualMessageRange(
  layout: VirtualMessageLayout,
  scrollTop: number,
  viewportHeight: number,
  overscan = DEFAULT_OVERSCAN,
): VirtualMessageRange {
  if (layout.items.length === 0) {
    return { startIndex: 0, endIndex: 0, topSpacer: 0, bottomSpacer: 0 };
  }
  const visibleTop = Math.max(0, scrollTop - overscan);
  const visibleBottom = Math.min(layout.totalSize, scrollTop + Math.max(viewportHeight, 1) + overscan);
  const startIndex = firstItemEndingAfter(layout.items, visibleTop);
  const endIndex = Math.max(startIndex + 1, firstItemStartingAfter(layout.items, visibleBottom));
  const clampedEnd = Math.min(layout.items.length, endIndex);
  const topSpacer = layout.items[startIndex]?.start ?? 0;
  const bottomSpacer = Math.max(0, layout.totalSize - (layout.items[clampedEnd - 1]?.end ?? 0));
  return { startIndex, endIndex: clampedEnd, topSpacer, bottomSpacer };
}

function findScrollElement(root: HTMLElement | null, explicit?: RefObject<HTMLElement>): HTMLElement | null {
  return explicit?.current ?? root?.closest<HTMLElement>(".stream-scroll") ?? null;
}

interface UseVirtualMessageWindowOptions {
  items: VirtualMessageItem[];
  rootRef: RefObject<HTMLDivElement>;
  scrollRef?: RefObject<HTMLElement>;
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder?: () => void | Promise<void>;
}

export function useVirtualMessageWindow({
  items,
  rootRef,
  scrollRef,
  hasMore,
  loadingOlder,
  onLoadOlder,
}: UseVirtualMessageWindowOptions) {
  const measuredHeights = useRef(new Map<string, number>());
  const previousLayout = useRef<VirtualMessageLayout | null>(null);
  const loadRequested = useRef(false);
  const stickToBottom = useRef(true);
  const [measurementVersion, setMeasurementVersion] = useState(0);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: DEFAULT_VIEWPORT_HEIGHT, ready: false });

  const layout = useMemo(
    () => buildVirtualMessageLayout(items, measuredHeights.current),
    // measurementVersion deliberately invalidates the layout after ResizeObserver updates the cache.
    [items, measurementVersion],
  );
  const effectiveScrollTop = viewport.ready
    ? viewport.scrollTop
    : Math.max(0, layout.totalSize - viewport.height);
  const range = useMemo(
    () => calculateVirtualMessageRange(layout, effectiveScrollTop, viewport.height),
    [effectiveScrollTop, layout, viewport.height],
  );

  const requestOlder = useCallback(() => {
    if (!hasMore || loadingOlder || loadRequested.current || !onLoadOlder) return;
    loadRequested.current = true;
    void Promise.resolve(onLoadOlder()).finally(() => {
      loadRequested.current = false;
    });
  }, [hasMore, loadingOlder, onLoadOlder]);

  useEffect(() => {
    const element = findScrollElement(rootRef.current, scrollRef);
    if (!element) return;
    const sync = (): void => {
      const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      stickToBottom.current = maxScrollTop - element.scrollTop <= STICK_TO_BOTTOM_THRESHOLD;
      setViewport((current) => {
        const next = { scrollTop: element.scrollTop, height: element.clientHeight, ready: true };
        return current.scrollTop === next.scrollTop && current.height === next.height && current.ready
          ? current
          : next;
      });
      if (element.scrollTop <= LOAD_OLDER_THRESHOLD) requestOlder();
    };
    element.addEventListener("scroll", sync, { passive: true });
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    sync();
    return () => {
      element.removeEventListener("scroll", sync);
      observer.disconnect();
    };
  }, [requestOlder, rootRef, scrollRef]);

  useBrowserLayoutEffect(() => {
    const element = findScrollElement(rootRef.current, scrollRef);
    const oldLayout = previousLayout.current;
    previousLayout.current = layout;
    if (!element || !oldLayout || oldLayout.items.length === 0 || layout.items.length === 0) return;

    const oldFirst = oldLayout.items[0];
    const newFirstIndex = layout.items.findIndex((item) => item.blockId === oldFirst.blockId);
    if (newFirstIndex <= 0) return;
    const newStart = layout.items[newFirstIndex].start;
    const delta = newStart - oldFirst.start;
    if (delta <= 0) return;
    element.scrollTop += delta;
    setViewport({ scrollTop: element.scrollTop, height: element.clientHeight, ready: true });
  }, [layout, rootRef, scrollRef]);

  useBrowserLayoutEffect(() => {
    const root = rootRef.current;
    const element = findScrollElement(root, scrollRef);
    if (!root || !element || typeof ResizeObserver === "undefined") return;
    // Width changes from the resizable sidebar can reflow mounted blocks. The
    // existing block observer measures those new heights and feeds them back
    // into the same virtual layout and anchor correction path used by folding,
    // streaming, and history hydration.
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      let correction = 0;
      const viewportTop = element.getBoundingClientRect().top;
      for (const entry of entries) {
        const node = entry.target as HTMLElement;
        const blockId = node.dataset.messageBlockId;
        if (!blockId) continue;
        const nextHeight = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        const previousHeight = measuredHeights.current.get(blockId);
        if (nextHeight <= 0 || (previousHeight !== undefined && Math.abs(previousHeight - nextHeight) < 0.5)) continue;
        measuredHeights.current.set(blockId, nextHeight);
        changed = true;
        if (!stickToBottom.current && node.getBoundingClientRect().bottom <= viewportTop + 1) {
          correction += nextHeight - (previousHeight ?? nextHeight);
        }
      }
      if (!changed) return;
      if (correction !== 0) element.scrollTop += correction;
      setMeasurementVersion((value) => value + 1);
      if (stickToBottom.current) {
        requestAnimationFrame(() => {
          element.scrollTop = element.scrollHeight;
        });
      }
    });
    root.querySelectorAll<HTMLElement>("[data-message-block-id]").forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [range.startIndex, range.endIndex, rootRef, scrollRef]);

  useBrowserLayoutEffect(() => {
    const element = findScrollElement(rootRef.current, scrollRef);
    if (!element || items.length === 0) return;
    const oldLayout = previousLayout.current;
    if (!oldLayout || oldLayout.items.length !== 0 || !stickToBottom.current) return;
    element.scrollTop = element.scrollHeight;
  }, [items.length, rootRef, scrollRef]);

  const revealBlock = useCallback(async (blockId: string): Promise<boolean> => {
    const root = rootRef.current;
    const element = findScrollElement(root, scrollRef);
    const item = layout.items.find((candidate) => candidate.blockId === blockId);
    if (!root || !element || !item) return false;

    stickToBottom.current = false;
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const centeredTop = item.start - Math.max(0, (element.clientHeight - item.size) / 2);
    const nextScrollTop = Math.min(maxScrollTop, Math.max(0, centeredTop));
    element.scrollTop = nextScrollTop;
    setViewport({ scrollTop: nextScrollTop, height: element.clientHeight, ready: true });
    await waitForPaint();
    const node = findBlockNode(rootRef.current, blockId);
    if (!node) return false;
    centerBlock(element, node);
    setViewport({ scrollTop: element.scrollTop, height: element.clientHeight, ready: true });
    return true;
  }, [layout, rootRef, scrollRef]);

  return { layout, range, revealBlock };
}
