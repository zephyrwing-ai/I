import type { LocalPoint, Radians } from "@agent-studio/canvas-math";
import type {
  FONT_FAMILY,
  ROUNDNESS,
  TEXT_ALIGN,
  THEME,
  VERTICAL_ALIGN,
} from "../constants";
import type {
  MakeBrand,
  MarkNonNullable,
  Merge,
  ValueOf,
} from "../utility-types";

export type ChartType = "bar" | "line";
export type FillStyle = "hachure" | "cross-hatch" | "solid" | "zigzag";
export type FontFamilyKeys = keyof typeof FONT_FAMILY;
export type FontFamilyValues = typeof FONT_FAMILY[FontFamilyKeys];
export type Theme = typeof THEME[keyof typeof THEME];
export type FontString = string & { _brand: "fontString" };
export type GroupId = string;
export type PointerType = "mouse" | "pen" | "touch";
export type StrokeRoundness = "round" | "sharp";
export type RoundnessType = ValueOf<typeof ROUNDNESS>;
export type StrokeStyle = "solid" | "dashed" | "dotted";
export type TextAlign = typeof TEXT_ALIGN[keyof typeof TEXT_ALIGN];

type VerticalAlignKeys = keyof typeof VERTICAL_ALIGN;
export type VerticalAlign = typeof VERTICAL_ALIGN[VerticalAlignKeys];
export type FractionalIndex = string & { _brand: "franctionalIndex" };

export type BoundElement = Readonly<{
  id: CanvasEditorLinearElement["id"];
  type: "arrow" | "text";
}>;

type _CanvasEditorElementBase = Readonly<{
  id: string;
  x: number;
  y: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: FillStyle;
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  roundness: null | { type: RoundnessType; value?: number };
  roughness: number;
  opacity: number;
  width: number;
  height: number;
  angle: Radians;
  /** Random integer used to seed shape generation so that the roughjs shape
      doesn't differ across renders. */
  seed: number;
  /** Integer that is sequentially incremented on each change. Used to reconcile
      elements during collaboration or when saving to server. */
  version: number;
  /** Random integer that is regenerated on each change.
      Used for deterministic reconciliation of updates during collaboration,
      in case the versions (see above) are identical. */
  versionNonce: number;
  /** String in a fractional form defined by https://github.com/rocicorp/fractional-indexing.
      Used for ordering in multiplayer scenarios, such as during reconciliation or undo / redo.
      Always kept in sync with the array order by `syncMovedIndices` and `syncInvalidIndices`.
      Could be null, i.e. for new elements which were not yet assigned to the scene. */
  index: FractionalIndex | null;
  isDeleted: boolean;
  /** List of groups the element belongs to.
      Ordered from deepest to shallowest. */
  groupIds: readonly GroupId[];
  frameId: string | null;
  /** other elements that are bound to this element */
  boundElements: readonly BoundElement[] | null;
  /** epoch (ms) timestamp of last element update */
  updated: number;
  link: string | null;
  locked: boolean;
  customData?: Record<string, any>;
}>;

export type CanvasEditorSelectionElement = _CanvasEditorElementBase & {
  type: "selection";
};

export type CanvasEditorRectangleElement = _CanvasEditorElementBase & {
  type: "rectangle";
};

export type CanvasEditorDiamondElement = _CanvasEditorElementBase & {
  type: "diamond";
};

export type CanvasEditorEllipseElement = _CanvasEditorElementBase & {
  type: "ellipse";
};

export type CanvasEditorEmbeddableElement = _CanvasEditorElementBase &
  Readonly<{
    type: "embeddable";
  }>;

export type MagicGenerationData =
  | {
      status: "pending";
    }
  | { status: "done"; html: string }
  | {
      status: "error";
      message?: string;
      code: "ERR_GENERATION_INTERRUPTED" | string;
    };

export type CanvasEditorIframeElement = _CanvasEditorElementBase &
  Readonly<{
    type: "iframe";
    // TODO move later to AI-specific frame
    customData?: { generationData?: MagicGenerationData };
  }>;

export type CanvasEditorIframeLikeElement =
  | CanvasEditorIframeElement
  | CanvasEditorEmbeddableElement;

export type IframeData =
  | {
      intrinsicSize: { w: number; h: number };
      error?: Error;
      sandbox?: { allowSameOrigin?: boolean };
    } & (
      | { type: "video" | "generic"; link: string }
      | { type: "document"; srcdoc: (theme: Theme) => string }
    );

export type ImageCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
};

export type CanvasEditorImageElement = _CanvasEditorElementBase &
  Readonly<{
    type: "image";
    fileId: FileId | null;
    /** whether respective file is persisted */
    status: "pending" | "saved" | "error";
    /** X and Y scale factors <-1, 1>, used for image axis flipping */
    scale: [number, number];
    /** whether an element is cropped */
    crop: ImageCrop | null;
  }>;

export type InitializedCanvasEditorImageElement = MarkNonNullable<
  CanvasEditorImageElement,
  "fileId"
>;

export type CanvasEditorFrameElement = _CanvasEditorElementBase & {
  type: "frame";
  name: string | null;
};

export type CanvasEditorMagicFrameElement = _CanvasEditorElementBase & {
  type: "magicframe";
  name: string | null;
};

export type CanvasEditorFrameLikeElement =
  | CanvasEditorFrameElement
  | CanvasEditorMagicFrameElement;

/**
 * These are elements that don't have any additional properties.
 */
export type CanvasEditorGenericElement =
  | CanvasEditorSelectionElement
  | CanvasEditorRectangleElement
  | CanvasEditorDiamondElement
  | CanvasEditorEllipseElement;

export type CanvasEditorFlowchartNodeElement =
  | CanvasEditorRectangleElement
  | CanvasEditorDiamondElement
  | CanvasEditorEllipseElement;

export type CanvasEditorRectanguloidElement =
  | CanvasEditorRectangleElement
  | CanvasEditorImageElement
  | CanvasEditorTextElement
  | CanvasEditorFreeDrawElement
  | CanvasEditorIframeLikeElement
  | CanvasEditorFrameLikeElement
  | CanvasEditorEmbeddableElement;

/**
 * CanvasEditorElement should be JSON serializable and (eventually) contain
 * no computed data. The list of all CanvasEditorElements should be shareable
 * between peers and contain no state local to the peer.
 */
export type CanvasEditorElement =
  | CanvasEditorGenericElement
  | CanvasEditorTextElement
  | CanvasEditorLinearElement
  | CanvasEditorArrowElement
  | CanvasEditorFreeDrawElement
  | CanvasEditorImageElement
  | CanvasEditorFrameElement
  | CanvasEditorMagicFrameElement
  | CanvasEditorIframeElement
  | CanvasEditorEmbeddableElement;

export type CanvasEditorNonSelectionElement = Exclude<
  CanvasEditorElement,
  CanvasEditorSelectionElement
>;

export type Ordered<TElement extends CanvasEditorElement> = TElement & {
  index: FractionalIndex;
};

export type OrderedCanvasEditorElement = Ordered<CanvasEditorElement>;

export type NonDeleted<TElement extends CanvasEditorElement> = TElement & {
  isDeleted: boolean;
};

export type NonDeletedCanvasEditorElement = NonDeleted<CanvasEditorElement>;

export type CanvasEditorTextElement = _CanvasEditorElementBase &
  Readonly<{
    type: "text";
    fontSize: number;
    fontFamily: FontFamilyValues;
    text: string;
    textAlign: TextAlign;
    verticalAlign: VerticalAlign;
    containerId: CanvasEditorGenericElement["id"] | null;
    originalText: string;
    /**
     * If `true` the width will fit the text. If `false`, the text will
     * wrap to fit the width.
     *
     * @default true
     */
    autoResize: boolean;
    /**
     * Unitless line height (aligned to W3C). To get line height in px, multiply
     *  with font size (using `getLineHeightInPx` helper).
     */
    lineHeight: number & { _brand: "unitlessLineHeight" };
  }>;

export type CanvasEditorBindableElement =
  | CanvasEditorRectangleElement
  | CanvasEditorDiamondElement
  | CanvasEditorEllipseElement
  | CanvasEditorTextElement
  | CanvasEditorImageElement
  | CanvasEditorIframeElement
  | CanvasEditorEmbeddableElement
  | CanvasEditorFrameElement
  | CanvasEditorMagicFrameElement;

export type CanvasEditorTextContainer =
  | CanvasEditorRectangleElement
  | CanvasEditorDiamondElement
  | CanvasEditorEllipseElement
  | CanvasEditorArrowElement;

export type CanvasEditorTextElementWithContainer = {
  containerId: CanvasEditorTextContainer["id"];
} & CanvasEditorTextElement;

export type FixedPoint = [number, number];

export type PointBinding = {
  elementId: CanvasEditorBindableElement["id"];
  focus: number;
  gap: number;
};

export type FixedPointBinding = Merge<
  PointBinding,
  {
    // Represents the fixed point binding information in form of a vertical and
    // horizontal ratio (i.e. a percentage value in the 0.0-1.0 range). This ratio
    // gives the user selected fixed point by multiplying the bound element width
    // with fixedPoint[0] and the bound element height with fixedPoint[1] to get the
    // bound element-local point coordinate.
    fixedPoint: FixedPoint;
  }
>;

export type Arrowhead =
  | "arrow"
  | "bar"
  | "dot" // legacy. Do not use for new elements.
  | "circle"
  | "circle_outline"
  | "triangle"
  | "triangle_outline"
  | "diamond"
  | "diamond_outline"
  | "crowfoot_one"
  | "crowfoot_many"
  | "crowfoot_one_or_many";

export type CanvasEditorLinearElement = _CanvasEditorElementBase &
  Readonly<{
    type: "line" | "arrow";
    points: readonly LocalPoint[];
    lastCommittedPoint: LocalPoint | null;
    startBinding: PointBinding | null;
    endBinding: PointBinding | null;
    startArrowhead: Arrowhead | null;
    endArrowhead: Arrowhead | null;
  }>;

export type FixedSegment = {
  start: LocalPoint;
  end: LocalPoint;
  index: number;
};

export type CanvasEditorArrowElement = CanvasEditorLinearElement &
  Readonly<{
    type: "arrow";
    elbowed: boolean;
  }>;

export type CanvasEditorElbowArrowElement = Merge<
  CanvasEditorArrowElement,
  {
    elbowed: true;
    startBinding: FixedPointBinding | null;
    endBinding: FixedPointBinding | null;
    fixedSegments: readonly FixedSegment[] | null;
    /**
     * Marks that the 3rd point should be used as the 2nd point of the arrow in
     * order to temporarily hide the first segment of the arrow without losing
     * the data from the points array. It allows creating the expected arrow
     * path when the arrow with fixed segments is bound on a horizontal side and
     * moved to a vertical and vica versa.
     */
    startIsSpecial: boolean | null;
    /**
     * Marks that the 3rd point backwards from the end should be used as the 2nd
     * point of the arrow in order to temporarily hide the last segment of the
     * arrow without losing the data from the points array. It allows creating
     * the expected arrow path when the arrow with fixed segments is bound on a
     * horizontal side and moved to a vertical and vica versa.
     */
    endIsSpecial: boolean | null;
  }
>;

export type CanvasEditorFreeDrawElement = _CanvasEditorElementBase &
  Readonly<{
    type: "freedraw";
    points: readonly LocalPoint[];
    pressures: readonly number[];
    simulatePressure: boolean;
    lastCommittedPoint: LocalPoint | null;
  }>;

export type FileId = string & { _brand: "FileId" };

export type CanvasEditorElementType = CanvasEditorElement["type"];

/**
 * Map of excalidraw elements.
 * Unspecified whether deleted or non-deleted.
 * Can be a subset of Scene elements.
 */
export type ElementsMap = Map<CanvasEditorElement["id"], CanvasEditorElement>;

/**
 * Map of non-deleted elements.
 * Can be a subset of Scene elements.
 */
export type NonDeletedElementsMap = Map<
  CanvasEditorElement["id"],
  NonDeletedCanvasEditorElement
> &
  MakeBrand<"NonDeletedElementsMap">;

/**
 * Map of all excalidraw Scene elements, including deleted.
 * Not a subset. Use this type when you need access to current Scene elements.
 */
export type SceneElementsMap = Map<
  CanvasEditorElement["id"],
  Ordered<CanvasEditorElement>
> &
  MakeBrand<"SceneElementsMap">;

/**
 * Map of all non-deleted Scene elements.
 * Not a subset. Use this type when you need access to current Scene elements.
 */
export type NonDeletedSceneElementsMap = Map<
  CanvasEditorElement["id"],
  Ordered<NonDeletedCanvasEditorElement>
> &
  MakeBrand<"NonDeletedSceneElementsMap">;

export type ElementsMapOrArray =
  | readonly CanvasEditorElement[]
  | Readonly<ElementsMap>;
