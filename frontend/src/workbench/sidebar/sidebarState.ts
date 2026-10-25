import { WORKBENCH_MAIN_MIN_WIDTH, type SidebarWidthPolicy } from "../../shared/sidebar/sidebarGeometry";

export const WORKBENCH_SIDEBAR_DEFAULT_WIDTH = 360;
export const WORKBENCH_SIDEBAR_MIN_WIDTH = 280;
export const WORKBENCH_SIDEBAR_COLLAPSE_DISTANCE = 48;

export const WORKBENCH_SIDEBAR_POLICY: SidebarWidthPolicy = {
  defaultWidth: WORKBENCH_SIDEBAR_DEFAULT_WIDTH,
  minimumWidth: WORKBENCH_SIDEBAR_MIN_WIDTH,
  collapseDistance: WORKBENCH_SIDEBAR_COLLAPSE_DISTANCE,
  minimumContentWidth: WORKBENCH_MAIN_MIN_WIDTH,
};
