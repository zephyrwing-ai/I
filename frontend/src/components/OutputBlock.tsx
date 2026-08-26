import { useState } from "react";
import type { AgentAction } from "../store/agentReducer";

const COLLAPSE_THRESHOLD = 2000;
const PREVIEW = 600;

function statusLabel(status: AgentAction["status"]): string {
  return { pending: "等待执行", running: "执行中", done: "已完成" }[status];
}

export function OutputBlock({ action }: { action: AgentAction }) {
  const [expanded, setExpanded] = useState(false);
  const result = action.result ?? (action.status === "done" ? undefined : undefined);

  const shouldCollapse = result ? result.output.length > COLLAPSE_THRESHOLD : false;
  let shown = result?.output ?? "";
  if (shouldCollapse && !expanded) {
    shown = shown.slice(0, PREVIEW) + `\n… 已折叠（共 ${result!.output.length} 字符）`;
  }

  return (
    <div className="output">
      <div className="output-meta">
        <span className={`action-status action-${action.status}`}>
          {action.status === "running" ? <span className="spinner" /> : null}
          {statusLabel(action.status)}
        </span>
        {result && <span className="returncode">rc={result.returncode}</span>}
        {action.status === "done" && !result && <span>无输出</span>}
      </div>

      {shouldCollapse && (
        <button className="ghost-btn" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "收起" : "展开完整输出"}
        </button>
      )}
      {result?.output ? <pre className="output-pre">{shown}</pre> : null}

      {result?.truncated && result.fullOutputPath && (
        <button className="ghost-btn" onClick={() => window.agentAPI.openPath(result.fullOutputPath!)}>
          打开完整输出文件
        </button>
      )}
    </div>
  );
}
