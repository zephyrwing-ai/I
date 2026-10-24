import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject, type TransitionEvent } from "react";
import { clampSidebarWidth, sidebarFits, sidebarMaximumWidth, sidebarShouldCollapse, type SidebarWidthPolicy } from "./sidebarGeometry";

type SidebarPhase = "closed" | "opening" | "open" | "dragging" | "closing";

interface ResizableSidebarOptions {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side: "left" | "right";
  storageKey: string;
  policy: SidebarWidthPolicy;
  workspaceRef?: RefObject<HTMLElement>;
  collapseWhenNarrow?: boolean;
}

/** Width and input mechanics shared by both workbench sidebars. */
export function useResizableSidebar({ open, onOpenChange, side, storageKey, policy, workspaceRef, collapseWhenNarrow = true }: ResizableSidebarOptions) {
  const [phase, setPhase] = useState<SidebarPhase>(open ? "open" : "closed");
  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem(storageKey));
    return Number.isFinite(stored) && stored > 0 ? stored : policy.defaultWidth;
  });
  const [availableWidth, setAvailableWidth] = useState(() => window.innerWidth);
  const [dragWidth, setDragWidth] = useState(width);
  const [collapseReady, setCollapseReady] = useState(false);
  const shellRef = useRef<HTMLElement>(null);
  const availableWidthRef = useRef(availableWidth);
  availableWidthRef.current = availableWidth;
  const frameRef = useRef<number | null>(null);
  const cleanupDragRef = useRef<(() => void) | null>(null);
  const effectiveWidth = clampSidebarWidth(policy, width, availableWidth);
  const targetWidth = phase === "dragging" ? clampSidebarWidth(policy, dragWidth, availableWidth) : open ? effectiveWidth : 0;

  useEffect(() => {
    const measure = (): void => {
      const workspace = workspaceRef?.current;
      const shell = shellRef.current;
      // Measuring these siblings excludes the navigation, frame gaps and peer sidebar.
      setAvailableWidth(workspace && shell
        ? workspace.getBoundingClientRect().width + shell.getBoundingClientRect().width
        : window.innerWidth);
    };
    window.addEventListener("resize", measure);
    const observer = new ResizeObserver(measure);
    if (workspaceRef?.current) observer.observe(workspaceRef.current);
    measure();
    return () => {
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, [workspaceRef]);

  useEffect(() => {
    if (open && collapseWhenNarrow && !sidebarFits(policy, availableWidth)) onOpenChange(false);
  }, [availableWidth, collapseWhenNarrow, onOpenChange, open, policy]);

  useEffect(() => {
    if (!open) cleanupDragRef.current?.();
    setCollapseReady(false);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setPhase(open ? "open" : "closed");
      return;
    }
    setPhase((current) => {
      if (open && (current === "closed" || current === "closing")) return "opening";
      if (!open && current !== "closed") return "closing";
      return current;
    });
  }, [open]);

  useEffect(() => {
    if (shellRef.current) shellRef.current.inert = !open;
  }, [open]);

  useEffect(() => () => cleanupDragRef.current?.(), []);

  const commitWidth = (nextWidth: number): void => {
    setWidth(nextWidth);
    setDragWidth(nextWidth);
    try { localStorage.setItem(storageKey, String(nextWidth)); } catch { /* Keep resizing usable when preferences cannot be saved. */ }
  };

  const finishTransition = (event: TransitionEvent<HTMLElement>): void => {
    if (event.target !== shellRef.current || event.propertyName !== "width" || phase === "dragging") return;
    setPhase(open ? "open" : "closed");
  };

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !open || phase === "opening" || phase === "closing") return;
    event.preventDefault();
    event.currentTarget.focus();
    cleanupDragRef.current?.();
    const startX = event.clientX;
    const startWidth = effectiveWidth;
    const pointerId = event.pointerId;
    const resizer = event.currentTarget;
    if (event.nativeEvent.isTrusted) resizer.setPointerCapture(pointerId);
    const direction = side === "left" ? 1 : -1;
    let rawWidth = startWidth;
    setDragWidth(startWidth);
    setCollapseReady(false);
    setPhase("dragging");

    const cleanup = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancelPointer);
      window.removeEventListener("keydown", cancelKeyboard);
      window.removeEventListener("blur", cancel);
      if (resizer.hasPointerCapture(pointerId)) resizer.releasePointerCapture(pointerId);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      cleanupDragRef.current = null;
    };
    const move = (pointerEvent: PointerEvent): void => {
      if (pointerEvent.pointerId !== pointerId) return;
      rawWidth = startWidth + direction * (pointerEvent.clientX - startX);
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        setDragWidth(clampSidebarWidth(policy, rawWidth, availableWidthRef.current));
        setCollapseReady(sidebarShouldCollapse(policy, rawWidth));
      });
    };
    const finish = (pointerEvent: PointerEvent): void => {
      if (pointerEvent.pointerId !== pointerId) return;
      cleanup();
      setCollapseReady(false);
      if (sidebarShouldCollapse(policy, rawWidth)) {
        setPhase("closing");
        onOpenChange(false);
        return;
      }
      commitWidth(clampSidebarWidth(policy, rawWidth, availableWidthRef.current));
      setPhase("open");
    };
    const cancel = (): void => {
      cleanup();
      setDragWidth(startWidth);
      setCollapseReady(false);
      setPhase("open");
    };
    const cancelPointer = (pointerEvent: PointerEvent): void => { if (pointerEvent.pointerId === pointerId) cancel(); };
    const cancelKeyboard = (keyboardEvent: KeyboardEvent): void => {
      if (keyboardEvent.key !== "Escape") return;
      keyboardEvent.preventDefault();
      cancel();
    };
    cleanupDragRef.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancelPointer);
    window.addEventListener("keydown", cancelKeyboard);
    window.addEventListener("blur", cancel);
  };

  const resetWidth = (): void => commitWidth(clampSidebarWidth(policy, policy.defaultWidth, availableWidth));
  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!open || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    const direction = (event.key === "ArrowRight" ? 1 : -1) * (side === "left" ? 1 : -1);
    if (direction < 0 && effectiveWidth <= policy.minimumWidth) {
      onOpenChange(false);
      return;
    }
    commitWidth(clampSidebarWidth(policy, effectiveWidth + direction * (event.shiftKey ? 64 : 16), availableWidth));
  };

  return { shellRef, phase, effectiveWidth, targetWidth, collapseReady, maximumWidth: sidebarMaximumWidth(policy, availableWidth), finishTransition, startDrag, resetWidth, resizeWithKeyboard };
}
