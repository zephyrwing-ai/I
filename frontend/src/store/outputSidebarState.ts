export const OUTPUT_SIDEBAR_DEFAULT_WIDTH = 360;
export const OUTPUT_SIDEBAR_MIN_WIDTH = 280;
export const OUTPUT_SIDEBAR_MAX_WIDTH = 520;
export const OUTPUT_SIDEBAR_COLLAPSE_DISTANCE = 48;
export const OUTPUT_MAIN_COLUMN_MIN_WIDTH = 360;

export function shouldCollapseSidebar(rawWidth: number): boolean {
  return rawWidth <= OUTPUT_SIDEBAR_MIN_WIDTH - OUTPUT_SIDEBAR_COLLAPSE_DISTANCE;
}
