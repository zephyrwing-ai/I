/** Composer 持有的本地运行草稿；提供商目录由 Main 单独管理。 */
export interface RunSettings {
  modelOptionId: string;
}

export const DEFAULT_SETTINGS: RunSettings = {
  modelOptionId: "",
};
