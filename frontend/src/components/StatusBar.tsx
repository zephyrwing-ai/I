import type { AppStatus } from "../store/agentReducer";

const LABELS: Record<AppStatus, string> = {
  idle: "待命",
  running: "运行中…",
  completed: "✅ 完成",
  step_limit: "⚠️ 达到步数上限",
  error: "❌ 出错 / 已停止",
};

export function StatusBar({ status, totalSteps }: { status: AppStatus; totalSteps: number }) {
  return (
    <footer className="status-bar">
      <span className={`status-dot status-${status}`} />
      <span>{LABELS[status]}</span>
      {status !== "idle" && totalSteps > 0 && <span className="status-total">共 {totalSteps} 步</span>}
    </footer>
  );
}
