import { WORKBENCH_MAIN_MIN_WIDTH, type SidebarWidthPolicy } from "../../shared/sidebar/sidebarGeometry";

export const PROJECTS_SIDEBAR_POLICY: SidebarWidthPolicy = {
  defaultWidth: 240,
  minimumWidth: 180,
  collapseDistance: 48,
  minimumContentWidth: WORKBENCH_MAIN_MIN_WIDTH,
};
