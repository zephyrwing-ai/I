import {
  useEffect,
  useRef,
  useState,
  type RefObject,
  type TransitionEvent,
} from "react";

type FloatingPhase = "hidden" | "opening" | "open" | "closing";

function reducedMotionEnabled(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useFloatingPanel(
  open: boolean,
  returnFocusRef: RefObject<HTMLElement>,
) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(open);
  const [phase, setPhase] = useState<FloatingPhase>(open ? "open" : "hidden");
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);

    if (open) {
      setMounted(true);
      setPhase("opening");
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        setPhase("open");
      });
      return;
    }

    if (!mounted) return;
    if (reducedMotionEnabled()) {
      setMounted(false);
      setPhase("hidden");
      returnFocusRef.current?.focus();
      return;
    }
    setPhase("closing");

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [mounted, open, returnFocusRef]);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  const onTransitionEnd = (event: TransitionEvent<HTMLDivElement>): void => {
    if (event.target !== panelRef.current || event.propertyName !== "opacity") return;
    if (phase === "closing" && !open) {
      setMounted(false);
      setPhase("hidden");
      returnFocusRef.current?.focus();
    }
  };

  return { mounted, onTransitionEnd, panelRef, phase };
}
