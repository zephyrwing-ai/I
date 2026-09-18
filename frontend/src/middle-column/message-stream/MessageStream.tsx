import { forwardRef, useImperativeHandle, useMemo, useRef, type ReactNode, type RefObject } from "react";
import type { RunState } from "../../store/agentReducer";
import { buildMessageBlockRecords, type MessageBlockKind } from "../../store/messageBlocks";
import { normalizePunctuation } from "../../utils/punctuation";
import { FinalAnswer, RunProcess, type RunTiming } from "./RunProcess";
import { MessageMeta } from "./MessageMeta";
import { useVirtualMessageWindow, type VirtualMessageItem } from "./useVirtualMessageWindow";
import "./message-stream.css";

export interface MessageBlock extends VirtualMessageItem {
  kind: MessageBlockKind;
  searchText?: string;
  content: ReactNode;
}

const USER_MESSAGE_ESTIMATE = 88;
const RUN_PROCESS_ESTIMATE = 140;
const ASSISTANT_MESSAGE_ESTIMATE = 160;

function buildMessageBlocks(
  order: string[],
  runs: Record<string, RunState>,
  runTimings: Record<string, RunTiming>,
  activeSearchBlockId: string | null = null,
): MessageBlock[] {
  return buildMessageBlockRecords({ runOrder: order, runs }).flatMap((record): MessageBlock[] => {
    const run = runs[record.runId];
    if (!run) return [];
    if (record.kind === "user") {
      const taskText = normalizePunctuation(record.text ?? "");
      return [{
        blockId: record.blockId,
        kind: record.kind,
        searchText: record.text,
        estimatedHeight: USER_MESSAGE_ESTIMATE,
        content: (
          <div className="user-message-row">
            <div className="user-message-group">
              <div className={`user-message${activeSearchBlockId === record.blockId ? " search-active" : ""}`}>{taskText}</div>
              {run.taskAt !== undefined && <MessageMeta time={run.taskAt} text={taskText} />}
            </div>
          </div>
        ),
      }];
    }
    if (record.kind === "process") {
      return [{
        blockId: record.blockId,
        kind: record.kind,
        estimatedHeight: RUN_PROCESS_ESTIMATE,
        content: <RunProcess run={run} runTiming={runTimings[record.runId]} />,
      }];
    }
    return [{
      blockId: record.blockId,
      kind: record.kind,
      searchText: record.text,
      estimatedHeight: ASSISTANT_MESSAGE_ESTIMATE,
      content: <FinalAnswer run={run} runTiming={runTimings[record.runId]} active={activeSearchBlockId === record.blockId} />,
    }];
  });
}

/**
 * 消息列：纯文本行直接堆叠进入阅读流。
 * 每个 run = 用户消息（右对齐气泡 + 时间戳与复制行）+ 过程块（Working for 折叠行 + 展开内容）+ 最终答案。
 * 空状态保持空白视图；有内容时按 run 顺序呈现上述三部分。
 */
export interface MessageStreamHandle {
  revealBlock: (blockId: string) => Promise<boolean>;
}

export interface MessageStreamProps {
  order: string[];
  runs: Record<string, RunState>;
  runTimings: Record<string, RunTiming>;
  scrollRef?: RefObject<HTMLElement>;
  hasMore?: boolean;
  loadingOlder?: boolean;
  historyError?: string | null;
  onLoadOlder?: () => void | Promise<void>;
  activeSearchBlockId?: string | null;
}

export const MessageStream = forwardRef<MessageStreamHandle, MessageStreamProps>(function MessageStream({
  order,
  runs,
  runTimings,
  scrollRef,
  hasMore = false,
  loadingOlder = false,
  historyError = null,
  onLoadOlder,
  activeSearchBlockId = null,
}, ref) {
  const rootRef = useRef<HTMLDivElement>(null);
  const blocks = useMemo(
    () => buildMessageBlocks(order, runs, runTimings, activeSearchBlockId),
    [activeSearchBlockId, order, runTimings, runs],
  );
  const { range, revealBlock } = useVirtualMessageWindow({
    items: blocks,
    rootRef,
    scrollRef,
    hasMore,
    loadingOlder,
    onLoadOlder,
  });
  useImperativeHandle(ref, () => ({ revealBlock }), [revealBlock]);
  const visibleBlocks = blocks.slice(range.startIndex, range.endIndex);

  return (
    <div ref={rootRef} className="message-stream" data-block-count={blocks.length}>
      {(loadingOlder || historyError) && (
        <div className={`message-history-status${historyError ? " is-error" : ""}`} role={historyError ? "alert" : "status"}>
          {historyError ? (
            <button type="button" onClick={() => void onLoadOlder?.()}>
              History loading failed. Click to retry
            </button>
          ) : "Loading earlier messages…"}
        </div>
      )}
      <div className="message-virtual-spacer" data-virtual-spacer="top" style={{ height: range.topSpacer }} />
      {visibleBlocks.map((block, visibleIndex) => {
        const blockIndex = range.startIndex + visibleIndex;
        const hasFollowingAnswer = block.kind === "process" && blocks[blockIndex + 1]?.kind === "assistant";
        return (
        <div
          className={`message-virtual-block block-${block.kind}${hasFollowingAnswer ? " has-following-answer" : ""}`}
          data-message-block-id={block.blockId}
          key={block.blockId}
        >
          {block.content}
        </div>
        );
      })}
      <div className="message-virtual-spacer" data-virtual-spacer="bottom" style={{ height: range.bottomSpacer }} />
    </div>
  );
});

MessageStream.displayName = "MessageStream";
