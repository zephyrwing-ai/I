import type { ReactNode } from "react";
import "./Column.css";

/**
 * 中间列的唯一列：消息流与对话框共用的容器（列宽只在这里定义一次）。
 * 由 .main-column 的 grid 单行撑满高度；内部两行：滚动区 (minmax(0,1fr)) + 对话框 (auto)。
 */
export function Column({ children }: { children: ReactNode }) {
  return <div className="column">{children}</div>;
}
