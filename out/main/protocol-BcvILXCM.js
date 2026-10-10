const MAX_CLI_BYTES = 16 * 1024 * 1024;
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isCliRequest(value) {
  return isRecord(value) && value.kind === "canvas:apply" && Array.isArray(value.operations);
}
function isCliReply(value) {
  if (!isRecord(value)) return false;
  if (value.kind === "canvas:error") return typeof value.code === "string" && typeof value.message === "string";
  if (value.kind !== "canvas:result" || !isRecord(value.result)) return false;
  const result = value.result;
  return typeof result.requestId === "string" && typeof result.runId === "string" && (result.projectId === null || typeof result.projectId === "string") && typeof result.ok === "boolean" && (result.changed === void 0 || typeof result.changed === "boolean") && (result.error === void 0 || typeof result.error === "string") && (result.appliedElements === void 0 || Array.isArray(result.appliedElements) && result.appliedElements.every(isRecord)) && (result.conflicts === void 0 || Array.isArray(result.conflicts) && result.conflicts.every((conflict) => isRecord(conflict) && typeof conflict.id === "string" && typeof conflict.reason === "string" && (conflict.current === void 0 || isRecord(conflict.current)))) && (result.createdIds === void 0 || Array.isArray(result.createdIds) && result.createdIds.every((id) => typeof id === "string"));
}
export {
  MAX_CLI_BYTES as M,
  isRecord as a,
  isCliRequest as b,
  isCliReply as i
};
