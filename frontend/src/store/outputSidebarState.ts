export const OUTPUT_SIDEBAR_DEFAULT_WIDTH = 360;
export const OUTPUT_SIDEBAR_MIN_WIDTH = 280;
export const OUTPUT_SIDEBAR_COLLAPSE_DISTANCE = 48;
export const OUTPUT_MAIN_COLUMN_MIN_WIDTH = 360;

/**
 * The sidebar has no product-defined maximum width. Its effective maximum is
 * the space left after reserving the minimum usable message column.
 */
export function getOutputSidebarMaxWidth(viewportWidth: number): number {
  return Math.max(OUTPUT_SIDEBAR_MIN_WIDTH, viewportWidth - OUTPUT_MAIN_COLUMN_MIN_WIDTH);
}

export function canKeepOutputSidebarOpen(viewportWidth: number): boolean {
  return viewportWidth >= OUTPUT_SIDEBAR_MIN_WIDTH + OUTPUT_MAIN_COLUMN_MIN_WIDTH;
}

export function clampOutputSidebarWidth(width: number, viewportWidth: number): number {
  return Math.min(
    Math.max(width, OUTPUT_SIDEBAR_MIN_WIDTH),
    getOutputSidebarMaxWidth(viewportWidth),
  );
}

export function shouldCollapseSidebar(rawWidth: number): boolean {
  return rawWidth <= OUTPUT_SIDEBAR_MIN_WIDTH - OUTPUT_SIDEBAR_COLLAPSE_DISTANCE;
}
