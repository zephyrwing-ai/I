import { forwardRef, useImperativeHandle, useMemo, useRef, type ReactNode, type RefObject } from "react";
import type { RunState } from "../../store/agentReducer";
import { buildMessageBlockRecords, type MessageBlockKind } from "../../store/messageBlocks";
import { normalizePunctuation } from "../../utils/punctuation";
import { AssistantMessage } from "./AssistantMessage";
import { MessageMeta } from "./MessageMeta";
import { useI18n } from "../../shared/i18n";
import { useVirtualMessageWindow, type VirtualMessageItem } from "./useVirtualMessageWindow";
import "./message-stream.css";

export interface MessageBlock extends VirtualMessageItem {
  kind: MessageBlockKind;
  searchText?: string;
  content: ReactNode;
}

const USER_MESSAGE_ESTIMATE = 88;
const ASSISTANT_MESSAGE_ESTIMATE = 160;

function buildMessageBlocks(
  order: string[],
  runs: Record<string, RunState>,
  t: ReturnType<typeof useI18n>,
  activeSearchBlockId: string | null = null,
  onResendInput?: (runId: string, inputId: string) => void | Promise<void>,
): MessageBlock[] {
  return buildMessageBlockRecords({ runOrder: order, runs }).flatMap((record): MessageBlock[] => {
    const run = runs[record.runId];
    if (!run) return [];
    if (record.kind === "user") {
      const input = run.inputs[record.inputId];
      if (!input) return [];
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
              {input.status === "interrupted" && (
                <div className="user-message-interrupted">
                  <span>{t("Not applied")}</span>
                  {onResendInput && <button type="button" onClick={() => void onResendInput(record.runId, input.inputId)}>{t("Edit and resend")}</button>}
                </div>
              )}
              <MessageMeta time={input.at} text={taskText} />
            </div>
          </div>
        ),
      }];
    }
    return [{
      blockId: record.blockId,
      kind: record.kind,
      searchText: record.text,
      estimatedHeight: ASSISTANT_MESSAGE_ESTIMATE,
      content: (
        <AssistantMessage
          run={run}
          anchorInputId={record.anchorInputId}
          turnIds={record.turnIds}
          answerTurnId={record.answerTurnId}
          showDuration={record.showDuration}
          isWorking={record.isWorking}
          active={activeSearchBlockId === record.blockId}
        />
      ),
    }];
  });
}

/**
 * 消息列：纯文本行直接堆叠进入阅读流。
 * 同一 run 的时间线直接渲染用户和助手消息；turn 内的工具更新原助手块。
 * 空状态提示由主列布局居中展示；有内容时按稳定 blockId 虚拟化。
 */
export interface MessageStreamHandle {
  revealBlock: (blockId: string) => Promise<boolean>;
}

export interface MessageStreamProps {
  projectId?: string | null;
  historyGeneration?: number;
  historyHydrationVersion?: number;
  historyReady?: boolean;
  order: string[];
  runs: Record<string, RunState>;
  scrollRef?: RefObject<HTMLElement>;
  hasMore?: boolean;
  loadingOlder?: boolean;
  historyError?: string | null;
  onLoadOlder?: () => void | Promise<void>;
  activeSearchBlockId?: string | null;
  onResendInput?: (runId: string, inputId: string) => void | Promise<void>;
}

export const MessageStream = forwardRef<MessageStreamHandle, MessageStreamProps>(function MessageStream({
  projectId = null,
  historyGeneration = 0,
  historyHydrationVersion = 0,
  historyReady = true,
  order,
  runs,
  scrollRef,
  hasMore = false,
  loadingOlder = false,
  historyError = null,
  onLoadOlder,
  activeSearchBlockId = null,
  onResendInput,
}, ref) {
  const t = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const blocks = useMemo(
    () => buildMessageBlocks(order, runs, t, activeSearchBlockId, onResendInput),
    [activeSearchBlockId, onResendInput, order, runs, t],
  );
  const { range, revealBlock } = useVirtualMessageWindow({
    items: blocks,
    rootRef,
    scrollRef,
    projectId,
    historyGeneration,
    historyHydrationVersion,
    historyReady,
    hasMore,
    loadingOlder,
    onLoadOlder,
  });
  useImperativeHandle(ref, () => ({ revealBlock }), [revealBlock]);
  const visibleBlocks = blocks.slice(range.startIndex, range.endIndex);
  const loadingHistory = !historyReady && !historyError;

  return (
    <div ref={rootRef} className="message-stream" data-block-count={blocks.length}>
      {(loadingHistory || loadingOlder || historyError) && (
        <div className={`message-history-status${historyError ? " is-error" : ""}`} role={historyError ? "alert" : "status"}>
          {historyError ? (
            <button type="button" onClick={() => void onLoadOlder?.()}>
              {t("History loading failed. Click to retry")}
            </button>
          ) : t(loadingOlder ? "Loading earlier messages…" : "Loading history…")}
        </div>
      )}
      <div className="message-virtual-spacer" data-virtual-spacer="top" style={{ height: range.topSpacer }} />
      {visibleBlocks.map((block) => (
        <div
          className={`message-virtual-block block-${block.kind}`}
          data-message-block-id={block.blockId}
          key={block.blockId}
        >
          {block.content}
        </div>
      ))}
      <div className="message-virtual-spacer" data-virtual-spacer="bottom" style={{ height: range.bottomSpacer }} />
    </div>
  );
});

MessageStream.displayName = "MessageStream";
