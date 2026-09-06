import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";
import { normalizeMdast } from "../../utils/punctuation-md";

/**
 * 模型输出统一渲染出口：思考块、过程文本、最终答案共用。
 * 管道顺序：结构解析（mdast）→ 标点规范化（mdast 级，punctuation-md.ts）→ 渲染：
 * - remark-gfm：表格、删除线、任务列表；
 * - remark-breaks：单个换行渲染 <br>，延续既有"行贴着行"的展示节奏；
 * - 规范化插件排在最后：结构已知后再改文本，代码/行内代码天然豁免。
 * 原始数据不动：reducer 与 IPC 保持模型原文，复制与导出取原文。
 */
const REMARK_PLUGINS: PluggableList = [remarkGfm, remarkBreaks, normalizeMdast];

/** 结构定制：行内强调（加粗/斜体/删除线）以纯文本呈现——只保留结构类格式化（列表、标题、表格、代码块、引用）；
 * 外链由 Main 的 setWindowOpenHandler 转系统浏览器；表格包横向滚动容器。 */
const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  table: ({ node: _node, children, ...props }) => (
    <div className="md-table-wrap">
      <table {...props}>{children}</table>
    </div>
  ),
  strong: ({ children }) => <>{children}</>,
  em: ({ children }) => <>{children}</>,
  del: ({ children }) => <>{children}</>,
};

function MarkdownTextInner({
  text,
  className,
  searchable = false,
}: {
  text: string;
  className: string;
  searchable?: boolean;
}) {
  return (
    <div className={`${className} markdown`} data-searchable={searchable ? "" : undefined}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** 消息区域渲染频繁（流式 + 折叠），Memo 减少无关 re-render。 */
export const MarkdownText = memo(MarkdownTextInner);
