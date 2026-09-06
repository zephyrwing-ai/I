import type { ModelOption } from "../../../shell/shared/ipc";

export function retainSelectedModelOption(currentId: string, models: ModelOption[]): string {
  if (!currentId) return "";
  return models.some((model) => model.imported && model.modelOptionId === currentId) ? currentId : "";
}

export function restoreSelectedModelOption(storedId: string, models: ModelOption[]): string {
  if (!storedId) return "";
  return models.some((model) => model.imported && model.available && model.modelOptionId === storedId) ? storedId : "";
}
