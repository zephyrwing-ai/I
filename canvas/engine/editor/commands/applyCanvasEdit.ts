import type {
  CanvasEditChanges,
  CanvasEditCreateElement,
  CanvasEditElementRecord,
  CanvasEditImageFile,
  CanvasEditOperation,
  CanvasEditOutcome,
} from "../../../commands/types";
import { DEFAULT_ELEMENT_PROPS } from "../constants";
import { bindLinearElement, fixBindingsAfterDeletion } from "../element/binding";
import { getBoundTextElement, getContainerElement, redrawTextBoundingBox } from "../element/textElement";
import { isBoundToContainer, isFrameLikeElement } from "../element/typeChecks";
import { duplicateElements, newArrowElement, newElement, newFreeDrawElement, newImageElement, newLinearElement, newTextElement, refreshTextDimensions } from "../element/newElement";
import { arrayToMap, cloneJSON } from "../utils";
import { addToGroup } from "../groups";
import { randomId } from "../random";
import { getSizeFromPoints } from "../points";
import { moveAllLeft, moveAllRight, moveOneLeft, moveOneRight } from "../zindex";
import { syncInvalidIndices } from "../fractionalIndex";
import type { BinaryFileData, BinaryFiles, AppState } from "../types";
import type { CanvasEditorArrowElement, CanvasEditorBindableElement, CanvasEditorElement, CanvasEditorTextElement, FileId, NonDeletedSceneElementsMap } from "../element/types";
import { pointFrom, type LocalPoint, type Radians } from "@agent-studio/canvas-math";
import { newElementWith } from "../element/mutateElement";

const MAX_OPERATIONS = 32;
const MAX_ELEMENTS = 20_000;
const MAX_FILES = 1_000;
const MAX_COORDINATE = 1_000_000;
const ELEMENT_TYPES = new Set(["rectangle", "ellipse", "diamond", "line", "arrow", "freedraw", "text", "image"]);
const GEOMETRY_FIELDS = ["x", "y", "width", "height", "angle"] as const;
const TEXT_FIELDS = ["text", "originalText", "width", "height", "fontSize", "fontFamily", "lineHeight", "autoResize", "textAlign", "verticalAlign", "containerId"] as const;

export interface CanvasEditApplyInput {
  elements: readonly CanvasEditorElement[];
  appState: AppState;
  files: BinaryFiles;
  operations: CanvasEditOperation[];
  sourceElements: CanvasEditElementRecord[];
  imageFiles?: CanvasEditImageFile[];
}

export interface CanvasEditApplyOutput extends CanvasEditOutcome {
  elements?: CanvasEditorElement[];
  appState?: Partial<AppState>;
  filesToAdd?: BinaryFileData[];
}

/** Preflights against the live scene, then builds one immutable, undoable batch. */
export function applyCanvasEdit(input: CanvasEditApplyInput): CanvasEditApplyOutput {
  const { elements, appState, files, operations } = input;
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > MAX_OPERATIONS) {
    return { ok: false, error: "invalid_operation_count" };
  }
  if (elements.length > MAX_ELEMENTS) return { ok: false, error: "scene_too_large" };

  const currentById = new Map(elements.map((element) => [element.id, element]));
  const imageFiles = new Map((input.imageFiles ?? []).map((file) => [file.attachmentId, file]));
  const newFileIds = new Set([...imageFiles.values()].map((file) => file.fileId));
  if (Object.keys(files).length + newFileIds.size > MAX_FILES) return { ok: false, error: "too_many_image_files" };
  const sourceById = new Map<string, CanvasEditElementRecord>();
  for (const source of input.sourceElements) {
    if (typeof source.id !== "string" || source.isDeleted === true || source.deleted === true) {
      return { ok: false, error: "invalid_selection_baseline" };
    }
    sourceById.set(source.id, source);
  }

  for (const operation of operations) {
    if (operation.action === "create" && !validateCreate(operation.element, files, imageFiles)) {
      return { ok: false, error: "invalid_create" };
    }
    if (operation.action === "update") {
      const target = currentById.get(operation.id);
      if (target && !validateUpdate(target, operation.changes)) {
        return { ok: false, error: "invalid_update", conflicts: [{ id: operation.id, reason: "unsupported_fields", current: cloneJSON(target) }] };
      }
    }
  }

  const conflicts = preflight(operations, currentById, sourceById, files);
  if (conflicts.length) return { ok: false, error: "conflict", conflicts };

  // Clone once so all domain helpers operate on an isolated working scene.
  // No live element mutates until the complete command batch has succeeded.
  let next = cloneJSON([...elements]) as CanvasEditorElement[];
  const beforeById = new Map(next.map((element) => [element.id, cloneJSON(element)]));
  const createdIds: string[] = [];
  const appStatePatch: Partial<AppState> = {};
  const filesToAdd: BinaryFileData[] = [];

  try {
    for (const operation of operations) {
      const map = arrayToMap(next);
      if (operation.action === "create") {
        const element = createElement(operation.element, files, imageFiles, filesToAdd);
        next.push(element);
        if (element.type === "arrow" && (operation.element.startElementId || operation.element.endElementId)) {
          const liveMap = arrayToMap(next.filter((item) => !item.isDeleted)) as NonDeletedSceneElementsMap;
          if (operation.element.startElementId) {
            const target = liveMap.get(operation.element.startElementId);
            if (!target) throw new Error("The arrow start binding target is unavailable.");
            bindLinearElement(element as CanvasEditorArrowElement, target as CanvasEditorBindableElement, "start", liveMap);
          }
          if (operation.element.endElementId) {
            const target = liveMap.get(operation.element.endElementId);
            if (!target) throw new Error("The arrow end binding target is unavailable.");
            bindLinearElement(element as CanvasEditorArrowElement, target as CanvasEditorBindableElement, "end", liveMap);
          }
        }
        createdIds.push(element.id);
        continue;
      }

      if (operation.action === "update") {
        const current = map.get(operation.id)!;
        next = updateElement(next, current, operation.changes);
        continue;
      }

      if (operation.action === "delete") {
        const target = map.get(operation.id)!;
        next = deleteElements(next, [target]);
        continue;
      }

      if (operation.action === "duplicate") {
        const target = map.get(operation.id)!;
        const relatedText = target.boundElements?.flatMap((binding: NonNullable<CanvasEditorElement["boundElements"]>[number]) => {
          const element = map.get(binding.id);
          return binding.type === "text" && element && !element.isDeleted ? [element] : [];
        }) ?? [];
        const duplicates = duplicateElements([target, ...relatedText], { randomizeSeed: true })
          .map((element) => ({
            ...element,
            x: element.x + (operation.offsetX ?? 20),
            y: element.y + (operation.offsetY ?? 20),
          } as CanvasEditorElement));
        next.push(...duplicates);
        createdIds.push(...duplicates.map((element) => element.id));
        continue;
      }

      if (operation.action === "reorder") {
        const state = { ...appState, selectedElementIds: { [operation.id]: true as const } };
        const reordered = operation.direction === "front"
          ? moveAllRight(next, state)
          : operation.direction === "back"
            ? moveAllLeft(next, state)
            : operation.direction === "forward"
              ? moveOneRight(next, state)
              : moveOneLeft(next, state);
        next = [...reordered];
        continue;
      }

      if (operation.action === "flip") {
        const current = map.get(operation.id)!;
        if (current.type !== "image") throw new Error("flip is only available for images.");
        const scale: [number, number] = operation.axis === "horizontal"
          ? [-current.scale[0], current.scale[1]]
          : [current.scale[0], -current.scale[1]];
        next = next.map((element) => element.id === operation.id ? changed(element, { scale }) : element);
        continue;
      }

      if (operation.action === "setLocked") {
        next = next.map((element) => element.id === operation.id
          ? changed(element, { locked: operation.locked })
          : element);
        continue;
      }

      if (operation.action === "group") {
        const targets = operation.ids.map((id) => map.get(id)!);
        const firstTarget = targets[0];
        if (!firstTarget) return { ok: false, error: "group_selection_invalid" };
        if (targets.some((element) => isBoundToContainer(element) || isFrameLikeElement(element)) ||
            new Set(targets.map((element) => element.frameId)).size !== 1) {
          return { ok: false, error: "group_relationship_unsupported" };
        }
        const groupId = randomId();
        const ids = new Set(operation.ids);
        next = next.map((element) => ids.has(element.id)
          ? changed(element, { groupIds: addToGroup(element.groupIds, groupId, appState.editingGroupId) })
          : element);
        continue;
      }

      if (operation.action === "ungroup") {
        const targets = operation.ids.map((id) => map.get(id)!);
        const firstTarget = targets[0];
        if (!firstTarget) return { ok: false, error: "group_selection_invalid" };
        const commonGroups = firstTarget.groupIds.filter((groupId: string) => targets.every((element) => element.groupIds.includes(groupId)));
        const groupId = commonGroups[commonGroups.length - 1];
        if (!groupId) return { ok: false, error: "selection_not_grouped" };
        const ids = new Set(operation.ids);
        const members = next.filter((element) => !element.isDeleted && element.groupIds.includes(groupId));
        if (members.some((element) => !ids.has(element.id))) return { ok: false, error: "group_not_fully_referenced" };
        next = next.map((element) => ids.has(element.id)
          ? changed(element, { groupIds: element.groupIds.filter((id) => id !== groupId) })
          : element);
      }
    }

    if (next.length > MAX_ELEMENTS) return { ok: false, error: "scene_too_large" };
    next = syncInvalidIndices(next);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid_operation" };
  }

  const appliedElements = next.filter((element) => {
    const before = beforeById.get(element.id);
    return !before || before.versionNonce !== element.versionNonce || before.index !== element.index || before.isDeleted !== element.isDeleted;
  });
  const hasChanges = appliedElements.length > 0;
  if (!hasChanges) return { ok: true, changed: false, appliedElements: [], createdIds: [] };

  const deleted = new Set(appliedElements.filter((element) => element.isDeleted).map((element) => element.id));
  if (deleted.size) {
    const selectedElementIds = { ...appState.selectedElementIds };
    for (const id of deleted) delete selectedElementIds[id];
    appStatePatch.selectedElementIds = selectedElementIds;
    appStatePatch.selectedGroupIds = {};
  }

  // Bound dependants changed by the editor are included in the result so the
  // next tool call can use their latest versions as its base.
  const resultById = new Map(appliedElements.map((element) => [element.id, element]));
  for (const element of next) {
    const before = beforeById.get(element.id);
    if (before && before.versionNonce !== element.versionNonce) resultById.set(element.id, element);
  }

  return {
    ok: true,
    changed: true,
    elements: next,
    appState: appStatePatch,
    ...(filesToAdd.length ? { filesToAdd } : {}),
    appliedElements: [...resultById.values()].map((element) => cloneJSON(element)),
    createdIds,
  };
}

function preflight(
  operations: CanvasEditOperation[],
  currentById: Map<string, CanvasEditorElement>,
  sourceById: Map<string, CanvasEditElementRecord>,
  files: BinaryFiles,
): Array<{ id: string; reason: string; current?: CanvasEditElementRecord }> {
  const conflicts: Array<{ id: string; reason: string; current?: CanvasEditElementRecord }> = [];
  const deletedEarlier = new Set<string>();
  for (const operation of operations) {
    if (operation.action === "create") {
      if (operation.element.type === "arrow") {
        for (const id of [operation.element.startElementId, operation.element.endElementId]) {
          if (!id) continue;
          const base = sourceById.get(id);
          const current = currentById.get(id);
          if (!base || !current || current.isDeleted ||
              ["x", "y", "width", "height", "angle", "isDeleted"].some((field) =>
                !deepEqual((base as Record<string, unknown>)[field], (current as unknown as Record<string, unknown>)[field]))) {
            conflicts.push({ id, reason: "concurrent_arrow_binding_target", ...(current ? { current: cloneJSON(current) } : {}) });
          }
        }
      }
      continue;
    }
    const ids = operation.action === "group" || operation.action === "ungroup" ? operation.ids : [operation.id];
    for (const id of ids) {
      const base = sourceById.get(id);
      const current = currentById.get(id);
      if (deletedEarlier.has(id) || !base || !current || current.isDeleted || base.isDeleted === true) {
        conflicts.push({ id, reason: "element_unavailable", ...(current ? { current: cloneJSON(current) } : {}) });
        continue;
      }
      const group = conflictFields(operation, current);
      if (group.some((field) => !deepEqual((base as Record<string, unknown>)[field], (current as unknown as Record<string, unknown>)[field]))) {
        conflicts.push({ id, reason: `concurrent_${group.join("_")}`, current: cloneJSON(current) });
      }
    }
    if (operation.action === "delete") deletedEarlier.add(operation.id);
  }
  return conflicts;
}

function conflictFields(operation: CanvasEditOperation, current: CanvasEditorElement): string[] {
  if (operation.action === "update") {
    const fields = Object.keys(operation.changes);
    const result = new Set<string>();
    if (fields.some((field) => (GEOMETRY_FIELDS as readonly string[]).includes(field))) {
      result.add("x"); result.add("y"); result.add("width"); result.add("height"); result.add("angle");
    }
    if (fields.includes("text")) for (const field of TEXT_FIELDS) result.add(field);
    if (fields.includes("points")) { result.add("points"); result.add("x"); result.add("y"); result.add("width"); result.add("height"); }
    if (fields.includes("scale") || fields.includes("crop")) { result.add("scale"); result.add("crop"); }
    return [...result];
  }
  if (operation.action === "setLocked") return ["locked"];
  if (operation.action === "flip") return ["scale", "isDeleted"];
  if (operation.action === "group" || operation.action === "ungroup") return ["groupIds", "frameId", "isDeleted"];
  if (operation.action === "reorder") return ["index", "groupIds", "frameId", "isDeleted"];
  if (operation.action === "duplicate") return ["x", "y", "width", "height", "angle", "points", "groupIds", "frameId", "isDeleted"];
  return ["version", "versionNonce", "isDeleted"];
}

function updateElement(
  elements: CanvasEditorElement[],
  current: CanvasEditorElement,
  changes: CanvasEditChanges,
): CanvasEditorElement[] {
  const map = arrayToMap(elements);
  let nextElement: CanvasEditorElement;
  if (current.type === "text" && (typeof changes.text === "string" || changes.width !== undefined)) {
    const container = getContainerElement(current, map);
    const sourceText = changes.text ?? current.originalText;
    const measuringElement = changes.width === undefined
      ? current
      : { ...current, width: changes.width, autoResize: false };
    const dimensions = refreshTextDimensions(measuringElement, container, map, sourceText);
    if (!dimensions) throw new Error("The text element could not be resized.");
    const textChanges: Partial<CanvasEditorTextElement> = {
      ...(changes.x === undefined ? {} : { x: changes.x }),
      ...(changes.y === undefined ? {} : { y: changes.y }),
      text: dimensions.text,
      originalText: changes.text ?? current.originalText,
      x: changes.x ?? dimensions.x,
      y: changes.y ?? dimensions.y,
      width: changes.width ?? dimensions.width,
      height: dimensions.height,
      ...(changes.width === undefined ? {} : { autoResize: false }),
    };
    nextElement = changed(current, textChanges);
    const nextMap = arrayToMap(elements.map((element) => element.id === current.id ? nextElement : element));
    redrawTextBoundingBox(nextElement as CanvasEditorTextElement, container, nextMap, false);
  } else if ("points" in changes && changes.points) {
    if (!(current.type === "line" || current.type === "arrow" || current.type === "freedraw")) {
      throw new Error("points can only update a line, arrow, or freehand stroke.");
    }
    if ((current.type === "line" || current.type === "arrow") &&
        ((current.startBinding && current.startBinding.elementId) || (current.endBinding && current.endBinding.elementId))) {
      throw new Error("Bound arrows and lines cannot replace their path points directly.");
    }
    nextElement = changed(current, {
      ...changes,
      points: changes.points.map(([x, y]) => pointFrom(x, y) as LocalPoint),
      ...getSizeFromPoints(changes.points.map(([x, y]) => pointFrom(x, y) as LocalPoint)),
    } as never);
  } else {
    nextElement = changed(current, changes as never);
  }
  return elements.map((element) => element.id === current.id ? nextElement : element);
}

function deleteElements(elements: CanvasEditorElement[], targets: CanvasEditorElement[]): CanvasEditorElement[] {
  const map = arrayToMap(elements);
  const deletedIds = new Set(targets.map((element) => element.id));
  for (const target of targets) {
    const boundText = getBoundTextElement(target, map);
    if (boundText) deletedIds.add(boundText.id);
  }
  const deleted = elements.filter((element) => deletedIds.has(element.id));
  fixBindingsAfterDeletion(elements, deleted);
  return elements.map((element) => {
    if (deletedIds.has(element.id)) return changed(element, { isDeleted: true });
    if (element.frameId && deletedIds.has(element.frameId)) return changed(element, { frameId: null });
    return element;
  });
}

function createElement(
  draft: CanvasEditCreateElement,
  files: BinaryFiles,
  imageFiles: Map<string, CanvasEditImageFile>,
  filesToAdd: BinaryFileData[],
): CanvasEditorElement {
  if (!validateCreate(draft, files, imageFiles)) throw new Error("The new element is invalid.");
  const defaults = DEFAULT_ELEMENT_PROPS;
  const width = draft.width ?? 100;
  const height = draft.height ?? 100;
  if (draft.type === "rectangle" || draft.type === "ellipse" || draft.type === "diamond") {
    return newElement({ type: draft.type, x: draft.x, y: draft.y, width, height, angle: draft.angle as Radians | undefined, ...defaults });
  }
  if (draft.type === "line") {
    const points = draft.points?.map(([x, y]) => pointFrom(x, y) as LocalPoint) ?? [pointFrom(0, 0) as LocalPoint, pointFrom(100, 0) as LocalPoint];
    const size = getSizeFromPoints(points);
    return newLinearElement({ type: "line", x: draft.x, y: draft.y, width: draft.width ?? size.width, height: draft.height ?? size.height, angle: draft.angle as Radians | undefined, points, ...defaults });
  }
  if (draft.type === "arrow") {
    const points = draft.points?.map(([x, y]) => pointFrom(x, y) as LocalPoint) ?? [pointFrom(0, 0) as LocalPoint, pointFrom(100, 0) as LocalPoint];
    const size = getSizeFromPoints(points);
    return newArrowElement({ type: "arrow", x: draft.x, y: draft.y, width: draft.width ?? size.width, height: draft.height ?? size.height, angle: draft.angle as Radians | undefined, points, endArrowhead: "arrow", ...defaults });
  }
  if (draft.type === "freedraw") {
    const points = (draft.points ?? []).map(([x, y]) => pointFrom(x, y) as LocalPoint);
    const size = getSizeFromPoints(points);
    return newFreeDrawElement({ type: "freedraw", x: draft.x, y: draft.y, width: draft.width ?? size.width, height: draft.height ?? size.height, angle: draft.angle as Radians | undefined, points, simulatePressure: false, ...defaults });
  }
  if (draft.type === "text") {
    return newTextElement({ x: draft.x, y: draft.y, text: draft.text ?? "", fontSize: 14, ...defaults });
  }
  let fileId = draft.fileId;
  if (draft.attachmentId) {
    const file = imageFiles.get(draft.attachmentId)!;
    fileId = file.fileId;
    filesToAdd.push({
      id: file.fileId as FileId,
      mimeType: file.mimeType as BinaryFileData["mimeType"],
      dataURL: file.dataURL as BinaryFileData["dataURL"],
      created: file.created,
    });
  }
  return newImageElement({ type: "image", x: draft.x, y: draft.y, width, height, fileId: fileId! as FileId, status: "saved", ...defaults });
}

function validateCreate(draft: CanvasEditCreateElement, files: BinaryFiles, imageFiles: Map<string, CanvasEditImageFile>): boolean {
  if (!draft || !ELEMENT_TYPES.has(draft.type) || !isCoordinate(draft.x) || !isCoordinate(draft.y)) return false;
  const allowedFields = new Set(["type", "x", "y", "width", "height", "angle"]);
  if (draft.type === "text") { allowedFields.add("text"); }
  if (draft.type === "line" || draft.type === "arrow" || draft.type === "freedraw") allowedFields.add("points");
  if (draft.type === "arrow") { allowedFields.add("startElementId"); allowedFields.add("endElementId"); }
  if (draft.type === "image") { allowedFields.add("fileId"); allowedFields.add("attachmentId"); }
  if ((draft.startElementId || draft.endElementId) && draft.type !== "arrow") return false;
  if ((draft.startElementId !== undefined && !isId(draft.startElementId)) || (draft.endElementId !== undefined && !isId(draft.endElementId))) return false;
  if (Object.keys(draft).some((key) => !allowedFields.has(key))) return false;
  for (const key of ["width", "height", "angle"] as const) {
    if (draft[key] !== undefined && !isCoordinate(draft[key])) return false;
  }
  if ((draft.width !== undefined && draft.width < 0) || (draft.height !== undefined && draft.height < 0)) return false;
  if (draft.type === "text" && (typeof draft.text !== "string" || draft.text.length > 20_000)) return false;
  if (["line", "arrow", "freedraw"].includes(draft.type)) {
    if (draft.points !== undefined && (!Array.isArray(draft.points) || draft.points.length < 2 || draft.points.length > 2_048 ||
        !draft.points.every((point: unknown) => Array.isArray(point) && point.length === 2 && point.every(isCoordinate)))) return false;
    if (draft.type === "freedraw" && !draft.points?.length) return false;
  }
  if (draft.type === "image") {
    if (draft.fileId && !files[draft.fileId]) return false;
    if (draft.attachmentId) {
      const file = imageFiles.get(draft.attachmentId);
      if (!file || !isCanvasImageFile(file)) return false;
    }
    if (Boolean(draft.fileId) === Boolean(draft.attachmentId)) return false;
  }
  return true;
}

function isCanvasImageFile(file: CanvasEditImageFile): boolean {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(file.fileId) || !/^image\/[a-z0-9.+-]{1,64}$/i.test(file.mimeType) ||
      !Number.isSafeInteger(file.created) || file.created < 0) return false;
  const match = /^data:([^;,]+);base64,([a-z0-9+/=\r\n]+)$/i.exec(file.dataURL);
  if (!match || match[1].toLowerCase() !== file.mimeType.toLowerCase()) return false;
  try {
    return atob(match[2].replace(/\s/g, "")).length <= 4 * 1024 * 1024;
  } catch {
    return false;
  }
}

function validateUpdate(element: CanvasEditorElement, changes: CanvasEditChanges): boolean {
  const keys = Object.keys(changes);
  if (keys.length === 0) return false;
  if (element.type === "text" && changes.height !== undefined) return false;
  if (element.type === "text" && changes.width !== undefined && isBoundToContainer(element)) return false;
  if (keys.some((key) => !(GEOMETRY_FIELDS as readonly string[]).includes(key) &&
      !(element.type === "text" && key === "text") &&
      !(element.type === "image" && (key === "scale" || key === "crop")) &&
      ((element.type === "line" || element.type === "arrow" || element.type === "freedraw") && key === "points" ? false : true))) {
    return false;
  }
  if (typeof changes.text === "string" && changes.text.length > 20_000) return false;
  if (changes.points && (changes.points.length < 2 || changes.points.length > 2_048 ||
      changes.points.some((point) => point.length !== 2 || !point.every(isCoordinate)))) return false;
  if ((changes.width !== undefined && changes.width < 0) || (changes.height !== undefined && changes.height < 0)) return false;
  if (changes.scale && (element.type !== "image" || changes.scale.length !== 2 ||
      changes.scale.some((scale) => !Number.isFinite(scale) || Math.abs(scale) > 1 || scale === 0))) return false;
  if (changes.crop && (element.type !== "image" ||
      !isCoordinate(changes.crop.x) || !isCoordinate(changes.crop.y) ||
      !isCoordinate(changes.crop.width) || !isCoordinate(changes.crop.height) ||
      !isCoordinate(changes.crop.naturalWidth) || !isCoordinate(changes.crop.naturalHeight) ||
      changes.crop.x < 0 || changes.crop.y < 0 || changes.crop.width <= 0 || changes.crop.height <= 0 ||
      changes.crop.naturalWidth <= 0 || changes.crop.naturalHeight <= 0 ||
      changes.crop.x + changes.crop.width > changes.crop.naturalWidth ||
      changes.crop.y + changes.crop.height > changes.crop.naturalHeight)) return false;
  return Object.values(changes).every((value) => {
    if (typeof value === "number") return isCoordinate(value);
    if (Array.isArray(value)) return value.every((point) => Array.isArray(point) ? point.every(isCoordinate) : isCoordinate(point));
    if (value && typeof value === "object") return true;
    return typeof value === "string";
  });
}

function changed<T extends CanvasEditorElement>(element: T, changes: Partial<T>): T {
  if (!Object.entries(changes).some(([key, value]) => !deepEqual((element as Record<string, unknown>)[key], value))) {
    return element;
  }
  return newElementWith(element, changes as never, true);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length && keys.every((key) => deepEqual(leftRecord[key], rightRecord[key]));
}

function isCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}
