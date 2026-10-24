export const WORKBENCH_MAIN_MIN_WIDTH = 360;

export interface SidebarWidthPolicy {
  defaultWidth: number;
  minimumWidth: number;
  collapseDistance: number;
  minimumContentWidth: number;
}

export function sidebarMaximumWidth(policy: SidebarWidthPolicy, availableWidth: number): number {
  return Math.max(policy.minimumWidth, availableWidth - policy.minimumContentWidth);
}

export function sidebarFits(policy: SidebarWidthPolicy, availableWidth: number): boolean {
  return availableWidth >= policy.minimumWidth + policy.minimumContentWidth;
}

export function clampSidebarWidth(policy: SidebarWidthPolicy, width: number, availableWidth: number): number {
  return Math.min(Math.max(width, policy.minimumWidth), sidebarMaximumWidth(policy, availableWidth));
}

export function sidebarShouldCollapse(policy: SidebarWidthPolicy, rawWidth: number): boolean {
  return rawWidth <= policy.minimumWidth - policy.collapseDistance;
}
