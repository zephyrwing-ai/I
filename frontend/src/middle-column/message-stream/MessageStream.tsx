import type { RunState } from "../../store/agentReducer";
import { normalizePunctuation } from "../../utils/punctuation";
import { RunProcess, type RunTiming } from "./RunProcess";
import { MessageMeta } from "./MessageMeta";
import "./message-stream.css";

/**
 * 消息列：纯文本行直接堆叠进入阅读流。
 * 每个 run = 用户消息（右对齐气泡 + 时间戳与复制行）+ 过程块（Working for 折叠行 + 展开内容）+ 最终答案。
 * 空状态保持空白视图；有内容时按 run 顺序呈现上述三部分。
 */
export function MessageStream({
  order,
  runs,
  runTimings,
}: {
  order: string[];
  runs: Record<string, RunState>;
  runTimings: Record<string, RunTiming>;
}) {
  return (
    <>
      {order.flatMap((runId) => {
        const run = runs[runId];
        if (!run) return [];
        const taskText = run.task ? normalizePunctuation(run.task) : "";
        return [
          run.task ? (
            <div className="user-message-row" key={`${runId}:task`}>
              <div className="user-message-group">
                <div className="user-message" data-searchable>{taskText}</div>
                {run.taskAt !== undefined && <MessageMeta time={run.taskAt} text={taskText} />}
              </div>
            </div>
          ) : null,
          <RunProcess key={runId} run={run} runTiming={runTimings[runId]} />,
        ];
      })}
    </>
  );
}
