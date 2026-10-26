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
export const STICK_TO_BOTTOM_THRESHOLD = 24;

export function shouldStickToBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  threshold = STICK_TO_BOTTOM_THRESHOLD,
): boolean {
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  return maxScrollTop - scrollTop <= threshold;
}

export function scrollToBottomInstant(element: Pick<HTMLElement, "scrollHeight" | "scrollTo">): void {
  element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
}

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

interface ReadingAnchor {
  blockId: string;
  offset: number;
}

interface MessageViewport {
  scrollTop: number;
  contentTop: number;
  height: number;
  ready: boolean;
  anchor: ReadingAnchor | null;
}

function layoutTop(node: HTMLElement): number {
  let top = node.offsetTop;
  let parent = node.offsetParent as HTMLElement | null;
  while (parent) {
    top += parent.offsetTop + parent.clientTop;
    parent = parent.offsetParent as HTMLElement | null;
  }
  return top;
}

function scrollContentTop(root: HTMLElement, element: HTMLElement): number {
  // Native layout coordinates include padding/banners, but exclude elastic transforms.
  return layoutTop(root) - layoutTop(element) - element.clientTop;
}

function captureReadingAnchor(
  root: HTMLElement,
  element: HTMLElement,
  layout: VirtualMessageLayout,
): ReadingAnchor | null {
  if (layout.items.length === 0) return null;
  const contentTop = scrollContentTop(root, element);
  const rootTop = root.getBoundingClientRect().top;
  for (const node of root.querySelectorAll<HTMLElement>("[data-message-block-id]")) {
    const blockId = node.dataset.messageBlockId;
    if (!blockId) continue;
    const rect = node.getBoundingClientRect();
    const top = contentTop + rect.top - rootTop;
    if (top + rect.height <= element.scrollTop) continue;
    if (top >= element.scrollTop + element.clientHeight) break;
    return { blockId, offset: top - element.scrollTop };
  }
  const item = layout.items[firstItemEndingAfter(layout.items, element.scrollTop - contentTop)];
  return { blockId: item.blockId, offset: contentTop + item.start - element.scrollTop };
}

function sameViewport(current: MessageViewport, next: MessageViewport): boolean {
  return current.scrollTop === next.scrollTop && current.contentTop === next.contentTop
    && current.height === next.height && current.ready === next.ready && current.anchor === next.anchor;
}

interface UseVirtualMessageWindowOptions {
  items: VirtualMessageItem[];
  rootRef: RefObject<HTMLDivElement>;
  scrollRef?: RefObject<HTMLElement>;
  projectId: string | null;
  historyGeneration: number;
  historyHydrationVersion: number;
  historyReady: boolean;
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder?: () => void | Promise<void>;
}

export function useVirtualMessageWindow({
  items,
  rootRef,
  scrollRef,
  projectId,
  historyGeneration,
  historyHydrationVersion,
  historyReady,
  hasMore,
  loadingOlder,
  onLoadOlder,
}: UseVirtualMessageWindowOptions) {
  const measuredHeights = useRef(new Map<string, number>());
  const committedWindow = useRef<{ layout: VirtualMessageLayout; height: number } | null>(null);
  const loadRequested = useRef(false);
  const activeScope = useRef({ projectId, historyGeneration });
  const positionedHistory = useRef({ projectId, historyGeneration, historyHydrationVersion, ready: false });
  const programmaticTop = useRef<number | null>(null);
  const revealEpoch = useRef(0);
  const stickToBottom = useRef(true);
  const [measurementVersion, setMeasurementVersion] = useState(0);
  const [viewport, setViewport] = useState<MessageViewport>({
    scrollTop: 0, contentTop: 0, height: DEFAULT_VIEWPORT_HEIGHT, ready: false, anchor: null,
  });

  const layout = useMemo(
    () => buildVirtualMessageLayout(items, measuredHeights.current),
    // measurementVersion deliberately invalidates the layout after ResizeObserver updates the cache.
    [items, measurementVersion],
  );
  const scopeChanged = activeScope.current.projectId !== projectId
    || activeScope.current.historyGeneration !== historyGeneration;
  const hydrationChanged = historyReady && (!positionedHistory.current.ready
    || positionedHistory.current.projectId !== projectId
    || positionedHistory.current.historyGeneration !== historyGeneration
    || positionedHistory.current.historyHydrationVersion !== historyHydrationVersion);
  const followingBottom = scopeChanged || hydrationChanged || !viewport.ready || stickToBottom.current;
  const anchorBlockId = viewport.anchor?.blockId;
  const anchorOffset = viewport.anchor?.offset ?? 0;
  const anchorItem = useMemo(
    () => anchorBlockId ? layout.items.find((item) => item.blockId === anchorBlockId) : undefined,
    [anchorBlockId, layout],
  );
  const effectiveScrollTop = followingBottom
    ? Math.max(0, layout.totalSize - viewport.height)
    : Math.max(0, anchorItem ? anchorItem.start - anchorOffset : viewport.scrollTop - viewport.contentTop);
  const range = useMemo(
    () => {
      const next = calculateVirtualMessageRange(layout, effectiveScrollTop, viewport.height);
      if (followingBottom || !anchorItem) return next;
      // Keep a partly visible anchor mounted even before its first height measurement.
      const startIndex = Math.min(next.startIndex, anchorItem.index);
      const endIndex = Math.max(next.endIndex, anchorItem.index + 1);
      return {
        startIndex, endIndex,
        topSpacer: layout.items[startIndex]?.start ?? 0,
        bottomSpacer: Math.max(0, layout.totalSize - (layout.items[endIndex - 1]?.end ?? 0)),
      };
    },
    [anchorItem, effectiveScrollTop, followingBottom, layout, viewport.height],
  );
  const observedBlockIds = JSON.stringify(items.slice(range.startIndex, range.endIndex).map((item) => item.blockId));

  const requestOlder = useCallback(() => {
    if (activeScope.current.projectId !== projectId || activeScope.current.historyGeneration !== historyGeneration) return;
    if (!hasMore || loadingOlder || loadRequested.current || !onLoadOlder) return;
    loadRequested.current = true;
    const requestScope = activeScope.current;
    void Promise.resolve(onLoadOlder()).finally(() => {
      if (activeScope.current === requestScope) loadRequested.current = false;
    });
  }, [hasMore, historyGeneration, loadingOlder, onLoadOlder, projectId]);

  useBrowserLayoutEffect(() => {
    const previousScope = activeScope.current;
    if (previousScope.projectId === projectId && previousScope.historyGeneration === historyGeneration) return;
    activeScope.current = { projectId, historyGeneration };
    measuredHeights.current.clear();
    committedWindow.current = null;
    revealEpoch.current += 1;
    loadRequested.current = false;
    stickToBottom.current = true;
    programmaticTop.current = null;

    const element = findScrollElement(rootRef.current, scrollRef);
    setViewport({
      scrollTop: 0, contentTop: 0, height: element?.clientHeight ?? DEFAULT_VIEWPORT_HEIGHT,
      ready: false, anchor: null,
    });
    setMeasurementVersion((value) => value + 1);
  }, [historyGeneration, projectId, rootRef, scrollRef]);

  useEffect(() => {
    const root = rootRef.current;
    const element = findScrollElement(root, scrollRef);
    if (!root || !element) return;
    const observedGeneration = historyGeneration;
    const sync = (userScrolled = false): void => {
      if (activeScope.current.projectId !== projectId || activeScope.current.historyGeneration !== observedGeneration) return;
      const userMoved = userScrolled && (programmaticTop.current === null
        || Math.abs(element.scrollTop - programmaticTop.current) > 0.5);
      const anchor = userMoved && committedWindow.current
        ? captureReadingAnchor(root, element, committedWindow.current.layout)
        : null;
      if (userMoved) {
        programmaticTop.current = null;
        revealEpoch.current += 1;
        stickToBottom.current = shouldStickToBottom(element.scrollTop, element.clientHeight, element.scrollHeight);
      }
      const position = {
        scrollTop: element.scrollTop, contentTop: scrollContentTop(root, element),
        height: element.clientHeight, ready: true,
      };
      setViewport((current) => {
        const next = { ...position, anchor: userMoved ? anchor : current.anchor };
        return sameViewport(current, next) ? current : next;
      });
      if (element.scrollTop <= LOAD_OLDER_THRESHOLD) requestOlder();
    };
    const onScroll = (): void => sync(true);
    element.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(() => sync());
    observer.observe(element);
    sync();
    return () => {
      element.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [historyGeneration, projectId, requestOlder, rootRef, scrollRef]);

  useBrowserLayoutEffect(() => {
    const root = rootRef.current;
    const element = findScrollElement(root, scrollRef);
    if (!root || !element) return;
    const previousWindow = committedWindow.current;
    const geometryChanged = !previousWindow || previousWindow.layout !== layout
      || previousWindow.height !== element.clientHeight;
    committedWindow.current = { layout, height: element.clientHeight };
    if (hydrationChanged) {
      stickToBottom.current = true;
      revealEpoch.current += 1;
    }
    positionedHistory.current = { projectId, historyGeneration, historyHydrationVersion, ready: historyReady };
    const contentTop = scrollContentTop(root, element);
    if (followingBottom) {
      // Following remains eligible within the bottom threshold, while a user's
      // own scroll must remain free to leave it without being snapped back.
      if (geometryChanged || hydrationChanged || !viewport.ready) {
        scrollToBottomInstant(element);
        programmaticTop.current = element.scrollTop;
      }
    } else {
      const node = anchorItem ? findBlockNode(root, anchorItem.blockId) : null;
      const anchorTop = node
        ? contentTop + node.getBoundingClientRect().top - root.getBoundingClientRect().top
        : contentTop + (anchorItem?.start ?? 0);
      const requestedTop = anchorItem ? anchorTop - anchorOffset : viewport.scrollTop;
      const top = Math.min(Math.max(0, element.scrollHeight - element.clientHeight), Math.max(0, requestedTop));
      if (Math.abs(element.scrollTop - top) > 0.5) {
        element.scrollTo({ top, behavior: "instant" });
        programmaticTop.current = element.scrollTop;
      }
    }
    // Own scroll/resize events preserve this anchor through estimate -> measured layouts.
    const anchor = followingBottom ? null : anchorItem ? viewport.anchor : captureReadingAnchor(root, element, layout);
    const next = { scrollTop: element.scrollTop, contentTop, height: element.clientHeight, ready: true, anchor };
    setViewport((current) => {
      return sameViewport(current, next) ? current : next;
    });
  }, [anchorItem, anchorOffset, followingBottom, historyGeneration, historyHydrationVersion, historyReady, hydrationChanged,
    layout, projectId, rootRef, scrollRef, viewport]);

  useBrowserLayoutEffect(() => {
    const root = rootRef.current;
    const element = findScrollElement(root, scrollRef);
    if (!root || !element || typeof ResizeObserver === "undefined") return;
    const observedGeneration = historyGeneration;
    // Measurement only updates layout sizes. Prepend, reflow, and first estimates
    // all restore the same reading anchor in the layout effect above.
    const observer = new ResizeObserver((entries) => {
      if (activeScope.current.projectId !== projectId || activeScope.current.historyGeneration !== observedGeneration) return;
      let changed = false;
      for (const entry of entries) {
        const node = entry.target as HTMLElement;
        const blockId = node.dataset.messageBlockId;
        if (!blockId) continue;
        const nextHeight = entry.borderBoxSize?.[0]?.blockSize ?? node.getBoundingClientRect().height;
        const previousHeight = measuredHeights.current.get(blockId);
        if (nextHeight <= 0 || (previousHeight !== undefined && Math.abs(previousHeight - nextHeight) < 0.5)) continue;
        measuredHeights.current.set(blockId, nextHeight);
        changed = true;
      }
      if (!changed) return;
      setMeasurementVersion((value) => value + 1);
    });
    root.querySelectorAll<HTMLElement>("[data-message-block-id]").forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [historyGeneration, observedBlockIds, projectId, rootRef, scrollRef]);

  const revealBlock = useCallback(async (blockId: string): Promise<boolean> => {
    const root = rootRef.current;
    const element = findScrollElement(root, scrollRef);
    const item = layout.items.find((candidate) => candidate.blockId === blockId);
    if (!root || !element || !item) return false;

    const epoch = ++revealEpoch.current;
    const scope = activeScope.current;
    stickToBottom.current = false;
    const contentTop = scrollContentTop(root, element);
    const anchor = { blockId, offset: Math.max(0, (element.clientHeight - item.size) / 2) };
    element.scrollTo({ top: Math.max(0, contentTop + item.start - anchor.offset), behavior: "instant" });
    programmaticTop.current = element.scrollTop;
    setViewport({ scrollTop: element.scrollTop, contentTop, height: element.clientHeight, ready: true, anchor });
    await waitForPaint();
    if (revealEpoch.current !== epoch || activeScope.current !== scope) return false;
    const node = findBlockNode(rootRef.current, blockId);
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    const centeredAnchor = { blockId, offset: Math.max(0, (element.clientHeight - rect.height) / 2) };
    const measuredContentTop = scrollContentTop(root, element);
    const top = measuredContentTop + rect.top - root.getBoundingClientRect().top - centeredAnchor.offset;
    element.scrollTo({ top: Math.max(0, top), behavior: "instant" });
    programmaticTop.current = element.scrollTop;
    setViewport({
      scrollTop: element.scrollTop, contentTop: measuredContentTop,
      height: element.clientHeight, ready: true, anchor: centeredAnchor,
    });
    return true;
  }, [layout, rootRef, scrollRef]);

  return { layout, range, revealBlock };
}
