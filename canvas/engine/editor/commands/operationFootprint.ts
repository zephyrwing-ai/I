import type { CanvasEditOperation } from "../../../commands/types";
import type { CanvasEditorElement } from "../element/types";

/**
 * Protection covers the domain objects an edit can change or depend on. Binding
 * edges are expanded one hop: moving A can move its arrow, but does not acquire
 * the arrow's other endpoint and that endpoint's entire connected graph.
 */
function createRelationships(elements: readonly CanvasEditorElement[]) {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const textByContainer = new Map<string, Set<string>>();
  const arrowsByEndpoint = new Map<string, Set<string>>();
  const childrenByFrame = new Map<string, Set<string>>();
  const membersByGroup = new Map<string, Set<string>>();
  const addRelation = (map: Map<string, Set<string>>, owner: string, id: string) => {
    const related = map.get(owner) ?? new Set<string>();
    related.add(id);
    map.set(owner, related);
  };
  for (const element of elements) {
    if (element.isDeleted) continue;
    if (element.type === "text" && element.containerId) {
      addRelation(textByContainer, element.containerId, element.id);
    }
    if (element.type === "arrow" || element.type === "line") {
      if (element.startBinding) addRelation(arrowsByEndpoint, element.startBinding.elementId, element.id);
      if (element.endBinding) addRelation(arrowsByEndpoint, element.endBinding.elementId, element.id);
    }
    if (element.frameId) addRelation(childrenByFrame, element.frameId, element.id);
    for (const groupId of element.groupIds) addRelation(membersByGroup, groupId, element.id);
  }

  const addText = (result: Set<string>, id: string) => {
    for (const textId of textByContainer.get(id) ?? []) result.add(textId);
    for (const binding of byId.get(id)?.boundElements ?? []) {
      if (binding.type === "text") result.add(binding.id);
    }
  };
  const addArrows = (result: Set<string>, id: string) => {
    const arrowIds = new Set(arrowsByEndpoint.get(id));
    for (const binding of byId.get(id)?.boundElements ?? []) {
      if (binding.type === "arrow") arrowIds.add(binding.id);
    }
    for (const arrowId of arrowIds) {
      result.add(arrowId);
      addText(result, arrowId);
    }
  };
  const addGeometry = (result: Set<string>, id: string) => {
    result.add(id);
    const element = byId.get(id);
    if (!element) return;
    addText(result, id);
    addArrows(result, id);
    if (element.type === "text" && element.containerId) {
      result.add(element.containerId);
      addText(result, element.containerId);
      addArrows(result, element.containerId);
      const container = byId.get(element.containerId);
      if (container?.type === "arrow" || container?.type === "line") {
        if (container.startBinding) result.add(container.startBinding.elementId);
        if (container.endBinding) result.add(container.endBinding.elementId);
      }
    }
    if (element.type === "arrow" || element.type === "line") {
      if (element.startBinding) result.add(element.startBinding.elementId);
      if (element.endBinding) result.add(element.endBinding.elementId);
    }
  };
  const addFrame = (result: Set<string>, id: string) => {
    const element = byId.get(id);
    if (element?.type === "frame" || element?.type === "magicframe") {
      for (const childId of childrenByFrame.get(id) ?? []) addGeometry(result, childId);
    }
  };
  const addGroups = (result: Set<string>, id: string) => {
    for (const groupId of byId.get(id)?.groupIds ?? []) {
      for (const memberId of membersByGroup.get(groupId) ?? []) {
        addGeometry(result, memberId);
      }
    }
  };
  return { addGeometry, addText, addFrame, addGroups };
}

/** Candidate set is recomputed from the live scene after a human gesture ends. */
export function getCanvasEditFootprint(
  operations: readonly CanvasEditOperation[],
  elements: readonly CanvasEditorElement[],
): Set<string> {
  const relationships = createRelationships(elements);
  const result = new Set<string>();
  for (const operation of operations) {
    if (operation.action === "create") {
      // Newly created objects have no live identity; arrow endpoint records do.
      if (operation.element.type === "arrow") {
        if (operation.element.startElementId) result.add(operation.element.startElementId);
        if (operation.element.endElementId) result.add(operation.element.endElementId);
      }
      continue;
    }
    const ids = operation.action === "group" || operation.action === "ungroup"
      ? operation.ids : [operation.id];
    for (const id of ids) {
      result.add(id);
      if (operation.action === "setLocked" || operation.action === "flip") continue;
      if (operation.action === "duplicate") {
        relationships.addText(result, id);
        continue;
      }
      relationships.addGeometry(result, id);
      if (operation.action === "delete" || operation.action === "reorder" ||
          operation.action === "group" || operation.action === "ungroup") {
        relationships.addFrame(result, id);
      }
      if (operation.action === "reorder" || operation.action === "group" || operation.action === "ungroup") {
        relationships.addGroups(result, id);
      }
    }
  }
  return result;
}

/**
 * Human operations supply their actual primary IDs. Geometry, membership and
 * direct binding effects are expanded here before the common mutation gate.
 * Added relatives remain terminal roots, preserving unrelated graph branches.
 */
export function expandHumanEditFootprint(
  ids: Iterable<string>,
  elements: readonly CanvasEditorElement[],
): Set<string> {
  const relationships = createRelationships(elements);
  const result = new Set<string>();
  for (const id of ids) {
    relationships.addGeometry(result, id);
    relationships.addFrame(result, id);
    relationships.addGroups(result, id);
  }
  return result;
}
