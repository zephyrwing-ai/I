import { getElementBounds } from "../element";
import type {
  ElementsMap,
  NonDeletedExcalidrawElement,
} from "../element/types";
import type { PointerCoords } from "../types";

/**
 * Finds the content item whose center is nearest to the current viewport
 * center. Call this when the viewport first becomes empty, not on every
 * pointer frame; the returned target remains stable while the user pans.
 */
export const getClosestElementToPoint = (
  elements: readonly NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
  point: PointerCoords,
): NonDeletedExcalidrawElement | null => {
  let closestElement: NonDeletedExcalidrawElement | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const element of elements) {
    const [x1, y1, x2, y2] = getElementBounds(element, elementsMap);
    const dx = (x1 + x2) / 2 - point.x;
    const dy = (y1 + y2) / 2 - point.y;
    const distance = dx * dx + dy * dy;

    if (distance < closestDistance) {
      closestDistance = distance;
      closestElement = element;
    }
  }

  return closestElement;
};

export {
  getOffscreenContentTarget,
  getOffscreenIndicatorPoint,
} from "./offscreenIndicatorGeometry";
export type { OffscreenIndicatorPoint } from "./offscreenIndicatorGeometry";
