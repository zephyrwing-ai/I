import { useMemo, useRef, type RefObject, type ReactNode } from "react";
import type { RunState } from "../../store/agentReducer";
import { normalizePunctuation } from "../../utils/punctuation";
import { RunProcess, type RunTiming } from "./RunProcess";
import { MessageMeta } from "./MessageMeta";
import { useVirtualMessageWindow, type VirtualMessageItem } from "./useVirtualMessageWindow";
import "./message-stream.css";

interface MessageBlock extends VirtualMessageItem {
  content: ReactNode;
}

const USER_MESSAGE_ESTIMATE = 88;
const RUN_PROCESS_ESTIMATE = 140;

function buildMessageBlocks(
  order: string[],
  runs: Record<string, RunState>,
  runTimings: Record<string, RunTiming>,
): MessageBlock[] {
  return order.flatMap((runId) => {
    const run = runs[runId];
    if (!run) return [];
    const blocks: MessageBlock[] = [];
    if (run.task) {
      const taskText = normalizePunctuation(run.task);
      blocks.push({
        blockId: `${runId}:task`,
        estimatedHeight: USER_MESSAGE_ESTIMATE,
        content: (
          <div className="user-message-row">
            <div className="user-message-group">
              <div className="user-message" data-searchable>{taskText}</div>
              {run.taskAt !== undefined && <MessageMeta time={run.taskAt} text={taskText} />}
            </div>
          </div>
        ),
      });
    }
    blocks.push({
      blockId: `${runId}:process`,
      estimatedHeight: RUN_PROCESS_ESTIMATE,
      content: <RunProcess run={run} runTiming={runTimings[runId]} />,
    });
    return blocks;
  });
}

/**
 * 消息列：纯文本行直接堆叠进入阅读流。
 * 每个 run = 用户消息（右对齐气泡 + 时间戳与复制行）+ 过程块（Working for 折叠行 + 展开内容）+ 最终答案。
 * 空状态保持空白视图；有内容时按 run 顺序呈现上述三部分。
 */
export function MessageStream({
  order,
  runs,
  runTimings,
  scrollRef,
  hasMore = false,
  loadingOlder = false,
  historyError = null,
  onLoadOlder,
}: {
  order: string[];
  runs: Record<string, RunState>;
  runTimings: Record<string, RunTiming>;
  scrollRef?: RefObject<HTMLElement>;
  hasMore?: boolean;
  loadingOlder?: boolean;
  historyError?: string | null;
  onLoadOlder?: () => void | Promise<void>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const blocks = useMemo(
    () => buildMessageBlocks(order, runs, runTimings),
    [order, runTimings, runs],
  );
  const { range } = useVirtualMessageWindow({
    items: blocks,
    rootRef,
    scrollRef,
    hasMore,
    loadingOlder,
    onLoadOlder,
  });
  const visibleBlocks = blocks.slice(range.startIndex, range.endIndex);

  return (
    <div ref={rootRef} className="message-stream" data-block-count={blocks.length}>
      {(loadingOlder || historyError) && (
        <div className={`message-history-status${historyError ? " is-error" : ""}`} role={historyError ? "alert" : "status"}>
          {historyError ? (
            <button type="button" onClick={() => void onLoadOlder?.()}>
              历史加载失败，点击重试
            </button>
          ) : "正在加载更早的消息…"}
        </div>
      )}
      <div className="message-virtual-spacer" data-virtual-spacer="top" style={{ height: range.topSpacer }} />
      {visibleBlocks.map((block) => (
        <div
          className="message-virtual-block"
          data-message-block-id={block.blockId}
          key={block.blockId}
        >
          {block.content}
        </div>
      ))}
      <div className="message-virtual-spacer" data-virtual-spacer="bottom" style={{ height: range.bottomSpacer }} />
    </div>
  );
}
