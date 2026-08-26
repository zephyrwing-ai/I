import { useState } from "react";
import type { RunRequest } from "../../../shell/shared/ipc";
import type { RunSettings } from "../store/runSettings";

interface ToolbarProps {
  running: boolean;
  settings: RunSettings;
  configOpen: boolean;
  onRun: (req: RunRequest) => void;
  onStop: () => void;
  onToggleConfig: () => void;
}

/** 顶栏 — 只负责「任务输入 + 运行/停止 + 设置开关」，配置全部收进右侧 Inspector。 */
export function Toolbar({ running, settings, configOpen, onRun, onStop, onToggleConfig }: ToolbarProps) {
  const [task, setTask] = useState("");

  const canRun = !running && task.trim() !== "" && settings.cwd !== "";

  const submit = (): void => {
    if (!canRun) return;
    onRun({
      task: task.trim(),
      provider: settings.provider,
      model: settings.model,
      baseURL: settings.baseURL || undefined,
      apiKey: settings.apiKey || undefined,
      useDocker: settings.useDocker,
      stepLimit: settings.stepLimit,
      cwd: settings.cwd,
    });
  };

  const onTaskKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <header className="toolbar">
      <div className="toolbar-brand">
        <span className="brand-dot" />
        <span className="brand-name">Agent Studio</span>
      </div>

      <textarea
        className="task-input"
        placeholder="描述你希望 agent 完成的任务…（Enter 运行，Shift+Enter 换行）"
        value={task}
        disabled={running}
        onChange={(e) => setTask(e.target.value)}
        onKeyDown={onTaskKeyDown}
      />

      <div className="toolbar-actions">
        {running ? (
          <button className="btn btn-stop" onClick={onStop}>
            停止
          </button>
        ) : (
          <button className="btn btn-run" onClick={submit} disabled={!canRun}>
            运行
          </button>
        )}
        <button
          className={`icon-btn ${configOpen ? "active" : ""}`}
          onClick={onToggleConfig}
          title="设置"
          aria-label="设置"
        >
          设置
        </button>
      </div>
    </header>
  );
}
