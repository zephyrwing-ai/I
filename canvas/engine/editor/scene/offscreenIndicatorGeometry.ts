export type PointerCoords = { x: number; y: number };

export type OffscreenIndicatorPoint = {
  left: number;
  top: number;
  rotation: number;
};

type SceneBounds = readonly [number, number, number, number];

type Viewport = {
  width: number;
  height: number;
  offsetLeft?: number;
  offsetTop?: number;
};

type OffscreenContentTargetInput = {
  selectedBounds: SceneBounds | null;
  sceneFallbackTarget: PointerCoords | null;
  sceneHasNoVisibleElements: boolean;
  editingText: boolean;
  viewport: Viewport & {
    scrollX: number;
    scrollY: number;
    zoom: number;
  };
};

const isBoundsOutsideViewport = (
  bounds: SceneBounds,
  viewport: NonNullable<OffscreenContentTargetInput["viewport"]>,
) => {
  const [x1, y1, x2, y2] = bounds;
  const left = (x1 + viewport.scrollX) * viewport.zoom + (viewport.offsetLeft ?? 0);
  const top = (y1 + viewport.scrollY) * viewport.zoom + (viewport.offsetTop ?? 0);
  const right = (x2 + viewport.scrollX) * viewport.zoom + (viewport.offsetLeft ?? 0);
  const bottom = (y2 + viewport.scrollY) * viewport.zoom + (viewport.offsetTop ?? 0);
  const viewportLeft = viewport.offsetLeft ?? 0;
  const viewportTop = viewport.offsetTop ?? 0;

  return (
    right < viewportLeft ||
    bottom < viewportTop ||
    left > viewportLeft + viewport.width ||
    top > viewportTop + viewport.height
  );
};

/**
 * Prioritizes a wholly offscreen selection. The general-scene target is only
 * used when rendering has confirmed that no scene elements are visible.
 */
export const getOffscreenContentTarget = ({
  selectedBounds,
  sceneFallbackTarget,
  sceneHasNoVisibleElements,
  editingText,
  viewport,
}: OffscreenContentTargetInput): PointerCoords | null => {
  if (editingText) {
    return null;
  }

  if (selectedBounds && isBoundsOutsideViewport(selectedBounds, viewport)) {
    const [x1, y1, x2, y2] = selectedBounds;
    return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  }

  return sceneHasNoVisibleElements ? sceneFallbackTarget : null;
};

/**
 * Places the indicator at the viewport boundary along the ray from its center
 * toward the target. UI controls do not create forbidden regions; normal
 * stacking and hit-testing priority remains with the UI above the canvas.
 */
export const getOffscreenIndicatorPoint = (
  target: PointerCoords,
  viewport: Viewport,
): OffscreenIndicatorPoint | null => {
  const { width, height } = viewport;
  if (width <= 0 || height <= 0) {
    return null;
  }

  const margin = Math.min(28, width / 2, height / 2);
  const centerX = width / 2;
  const centerY = height / 2;
  const dx = target.x - centerX;
  const dy = target.y - centerY;

  if (dx === 0 && dy === 0) {
    return null;
  }

  const distanceX =
    dx === 0 ? Number.POSITIVE_INFINITY : (width / 2 - margin) / Math.abs(dx);
  const distanceY =
    dy === 0 ? Number.POSITIVE_INFINITY : (height / 2 - margin) / Math.abs(dy);
  const rayScale = Math.min(distanceX, distanceY);
  const indicator = {
    left: Math.round(centerX + dx * rayScale),
    top: Math.round(centerY + dy * rayScale),
  };
  const rotation =
    (Math.atan2(target.y - indicator.top, target.x - indicator.left) *
      180) /
      Math.PI +
    90;

  return {
    left: indicator.left,
    top: indicator.top,
    rotation,
  };
};
