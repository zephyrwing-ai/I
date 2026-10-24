import { clampSidebarWidth, sidebarFits, sidebarMaximumWidth, sidebarShouldCollapse, WORKBENCH_MAIN_MIN_WIDTH, type SidebarWidthPolicy } from "../../shared/sidebar/sidebarGeometry";

export const OUTPUT_SIDEBAR_DEFAULT_WIDTH = 360;
export const OUTPUT_SIDEBAR_MIN_WIDTH = 280;
export const OUTPUT_SIDEBAR_COLLAPSE_DISTANCE = 48;
export const OUTPUT_MAIN_COLUMN_MIN_WIDTH = WORKBENCH_MAIN_MIN_WIDTH;

export const OUTPUT_SIDEBAR_POLICY: SidebarWidthPolicy = {
  defaultWidth: OUTPUT_SIDEBAR_DEFAULT_WIDTH,
  minimumWidth: OUTPUT_SIDEBAR_MIN_WIDTH,
  collapseDistance: OUTPUT_SIDEBAR_COLLAPSE_DISTANCE,
  minimumContentWidth: OUTPUT_MAIN_COLUMN_MIN_WIDTH,
};

/**
 * The sidebar has no product-defined maximum width. Its effective maximum is
 * the space left after reserving the minimum usable message column.
 */
export function getOutputSidebarMaxWidth(viewportWidth: number): number {
  return sidebarMaximumWidth(OUTPUT_SIDEBAR_POLICY, viewportWidth);
}

export function canKeepOutputSidebarOpen(viewportWidth: number): boolean {
  return sidebarFits(OUTPUT_SIDEBAR_POLICY, viewportWidth);
}

export function clampOutputSidebarWidth(width: number, viewportWidth: number): number {
  return clampSidebarWidth(OUTPUT_SIDEBAR_POLICY, width, viewportWidth);
}

export function shouldCollapseSidebar(rawWidth: number): boolean {
  return sidebarShouldCollapse(OUTPUT_SIDEBAR_POLICY, rawWidth);
}
