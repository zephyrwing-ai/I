import { ROUNDNESS } from "../constants";
import type { ElementOrToolType } from "../types";
import type { MarkNonNullable } from "../utility-types";
import { assertNever } from "../utils";
import type { Bounds } from "./bounds";
import type {
  CanvasEditorElement,
  CanvasEditorTextElement,
  CanvasEditorEmbeddableElement,
  CanvasEditorLinearElement,
  CanvasEditorBindableElement,
  CanvasEditorFreeDrawElement,
  InitializedCanvasEditorImageElement,
  CanvasEditorImageElement,
  CanvasEditorTextElementWithContainer,
  CanvasEditorTextContainer,
  CanvasEditorFrameElement,
  RoundnessType,
  CanvasEditorFrameLikeElement,
  CanvasEditorElementType,
  CanvasEditorIframeElement,
  CanvasEditorIframeLikeElement,
  CanvasEditorMagicFrameElement,
  CanvasEditorArrowElement,
  CanvasEditorElbowArrowElement,
  PointBinding,
  FixedPointBinding,
  CanvasEditorFlowchartNodeElement,
} from "./types";

export const isInitializedImageElement = (
  element: CanvasEditorElement | null,
): element is InitializedCanvasEditorImageElement => {
  return !!element && element.type === "image" && !!element.fileId;
};

export const isImageElement = (
  element: CanvasEditorElement | null,
): element is CanvasEditorImageElement => {
  return !!element && element.type === "image";
};

export const isEmbeddableElement = (
  element: CanvasEditorElement | null | undefined,
): element is CanvasEditorEmbeddableElement => {
  return !!element && element.type === "embeddable";
};

export const isIframeElement = (
  element: CanvasEditorElement | null,
): element is CanvasEditorIframeElement => {
  return !!element && element.type === "iframe";
};

export const isIframeLikeElement = (
  element: CanvasEditorElement | null,
): element is CanvasEditorIframeLikeElement => {
  return (
    !!element && (element.type === "iframe" || element.type === "embeddable")
  );
};

export const isTextElement = (
  element: CanvasEditorElement | null,
): element is CanvasEditorTextElement => {
  return element != null && element.type === "text";
};

export const isFrameElement = (
  element: CanvasEditorElement | null,
): element is CanvasEditorFrameElement => {
  return element != null && element.type === "frame";
};

export const isMagicFrameElement = (
  element: CanvasEditorElement | null,
): element is CanvasEditorMagicFrameElement => {
  return element != null && element.type === "magicframe";
};

export const isFrameLikeElement = (
  element: CanvasEditorElement | null,
): element is CanvasEditorFrameLikeElement => {
  return (
    element != null &&
    (element.type === "frame" || element.type === "magicframe")
  );
};

export const isFreeDrawElement = (
  element?: CanvasEditorElement | null,
): element is CanvasEditorFreeDrawElement => {
  return element != null && isFreeDrawElementType(element.type);
};

export const isFreeDrawElementType = (
  elementType: CanvasEditorElementType,
): boolean => {
  return elementType === "freedraw";
};

export const isLinearElement = (
  element?: CanvasEditorElement | null,
): element is CanvasEditorLinearElement => {
  return element != null && isLinearElementType(element.type);
};

export const isArrowElement = (
  element?: CanvasEditorElement | null,
): element is CanvasEditorArrowElement => {
  return element != null && element.type === "arrow";
};

export const isElbowArrow = (
  element?: CanvasEditorElement,
): element is CanvasEditorElbowArrowElement => {
  return isArrowElement(element) && element.elbowed;
};

export const isLinearElementType = (
  elementType: ElementOrToolType,
): boolean => {
  return (
    elementType === "arrow" || elementType === "line" // || elementType === "freedraw"
  );
};

export const isBindingElement = (
  element?: CanvasEditorElement | null,
  includeLocked = true,
): element is CanvasEditorLinearElement => {
  return (
    element != null &&
    (!element.locked || includeLocked === true) &&
    isBindingElementType(element.type)
  );
};

export const isBindingElementType = (
  elementType: ElementOrToolType,
): boolean => {
  return elementType === "arrow";
};

export const isBindableElement = (
  element: CanvasEditorElement | null | undefined,
  includeLocked = true,
): element is CanvasEditorBindableElement => {
  return (
    element != null &&
    (!element.locked || includeLocked === true) &&
    (element.type === "rectangle" ||
      element.type === "diamond" ||
      element.type === "ellipse" ||
      element.type === "image" ||
      element.type === "iframe" ||
      element.type === "embeddable" ||
      element.type === "frame" ||
      element.type === "magicframe" ||
      (element.type === "text" && !element.containerId))
  );
};

export const isRectanguloidElement = (
  element?: CanvasEditorElement | null,
): element is CanvasEditorBindableElement => {
  return (
    element != null &&
    (element.type === "rectangle" ||
      element.type === "diamond" ||
      element.type === "image" ||
      element.type === "iframe" ||
      element.type === "embeddable" ||
      element.type === "frame" ||
      element.type === "magicframe" ||
      (element.type === "text" && !element.containerId))
  );
};

// TODO: Remove this when proper distance calculation is introduced
// @see binding.ts:distanceToBindableElement()
export const isRectangularElement = (
  element?: CanvasEditorElement | null,
): element is CanvasEditorBindableElement => {
  return (
    element != null &&
    (element.type === "rectangle" ||
      element.type === "image" ||
      element.type === "text" ||
      element.type === "iframe" ||
      element.type === "embeddable" ||
      element.type === "frame" ||
      element.type === "magicframe" ||
      element.type === "freedraw")
  );
};

export const isTextBindableContainer = (
  element: CanvasEditorElement | null,
  includeLocked = true,
): element is CanvasEditorTextContainer => {
  return (
    element != null &&
    (!element.locked || includeLocked === true) &&
    (element.type === "rectangle" ||
      element.type === "diamond" ||
      element.type === "ellipse" ||
      isArrowElement(element))
  );
};

export const isCanvasEditorElement = (
  element: any,
): element is CanvasEditorElement => {
  const type: CanvasEditorElementType | undefined = element?.type;
  if (!type) {
    return false;
  }
  switch (type) {
    case "text":
    case "diamond":
    case "rectangle":
    case "iframe":
    case "embeddable":
    case "ellipse":
    case "arrow":
    case "freedraw":
    case "line":
    case "frame":
    case "magicframe":
    case "image":
    case "selection": {
      return true;
    }
    default: {
      assertNever(type, null);
      return false;
    }
  }
};

export const isFlowchartNodeElement = (
  element: CanvasEditorElement,
): element is CanvasEditorFlowchartNodeElement => {
  return (
    element.type === "rectangle" ||
    element.type === "ellipse" ||
    element.type === "diamond"
  );
};

export const hasBoundTextElement = (
  element: CanvasEditorElement | null,
): element is MarkNonNullable<CanvasEditorBindableElement, "boundElements"> => {
  return (
    isTextBindableContainer(element) &&
    !!element.boundElements?.some(({ type }) => type === "text")
  );
};

export const isBoundToContainer = (
  element: CanvasEditorElement | null,
): element is CanvasEditorTextElementWithContainer => {
  return (
    element !== null &&
    "containerId" in element &&
    element.containerId !== null &&
    isTextElement(element)
  );
};

export const isUsingAdaptiveRadius = (type: string) =>
  type === "rectangle" ||
  type === "embeddable" ||
  type === "iframe" ||
  type === "image";

export const isUsingProportionalRadius = (type: string) =>
  type === "line" || type === "arrow" || type === "diamond";

export const canApplyRoundnessTypeToElement = (
  roundnessType: RoundnessType,
  element: CanvasEditorElement,
) => {
  if (
    (roundnessType === ROUNDNESS.ADAPTIVE_RADIUS ||
      // if legacy roundness, it can be applied to elements that currently
      // use adaptive radius
      roundnessType === ROUNDNESS.LEGACY) &&
    isUsingAdaptiveRadius(element.type)
  ) {
    return true;
  }
  if (
    roundnessType === ROUNDNESS.PROPORTIONAL_RADIUS &&
    isUsingProportionalRadius(element.type)
  ) {
    return true;
  }

  return false;
};

export const getDefaultRoundnessTypeForElement = (
  element: CanvasEditorElement,
) => {
  if (isUsingProportionalRadius(element.type)) {
    return {
      type: ROUNDNESS.PROPORTIONAL_RADIUS,
    };
  }

  if (isUsingAdaptiveRadius(element.type)) {
    return {
      type: ROUNDNESS.ADAPTIVE_RADIUS,
    };
  }

  return null;
};

export const isFixedPointBinding = (
  binding: PointBinding | FixedPointBinding,
): binding is FixedPointBinding => {
  return (
    Object.hasOwn(binding, "fixedPoint") &&
    (binding as FixedPointBinding).fixedPoint != null
  );
};

// TODO: Move this to @agent-studio/canvas-math
export const isBounds = (box: unknown): box is Bounds =>
  Array.isArray(box) &&
  box.length === 4 &&
  typeof box[0] === "number" &&
  typeof box[1] === "number" &&
  typeof box[2] === "number" &&
  typeof box[3] === "number";
