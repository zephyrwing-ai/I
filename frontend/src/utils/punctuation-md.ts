/**
 * mdast 级中文标点规范化 —— remark 插件（结构解析后、渲染前）。
 *
 * 与字符串级（punctuation.ts）的关系：规则同源——复用同一份全角映射表、
 * 补空格集合与词内保护；区别只在执行位置与豁免粒度：
 * 1. 代码块与行内代码不产生 text 节点，按节点类型天然豁免（字符串级只能扫描 ``` 围栏）。
 * 2. 链接地址/图片地址只存在于节点属性，从不进入文本节点，天然豁免。
 * 3. 节点边界的补空格判断用「下一可见字符」——`你好,**世界**` 中逗号后看到的是
 *    「世」而非标记字符 `*`，空格补在正确位置。
 *
 * 幂等：每次渲染都从模型原始文本重新解析，规范化作用于新解析的树，结果稳定。
 */

import type { Root, Text } from "mdast";
import { visit } from "unist-util-visit";
import type { Node, Parent } from "unist";
import type { Plugin } from "unified";
import {
  FULLWIDTH_MAP,
  FULLWIDTH_RE,
  NEXT_SKIP,
  SPACE_PUNCT,
  WORD_RE,
  containsCJK,
} from "./punctuation";

/** 文本节点后直接字符集：取「下一个可见字符」；block 节点（code/image/break）与属性节点返回空串。 */
function firstVisibleChar(node: Node): string {
  if (node.type === "text" || node.type === "inlineCode") {
    return String((node as Text).value).charAt(0);
  }
  if (node.type === "break" || node.type === "html" || node.type === "math") return "";
  const children = (node as Parent).children;
  if (!children) return "";
  for (const child of children) {
    const ch = firstVisibleChar(child);
    if (ch) return ch;
  }
  return "";
}

/** 当前 text 节点之后第一个可见字符（跨过强调/链接/删除等结构性包装）。 */
function nextVisibleChar(parent: Parent, index: number): string {
  for (let i = index + 1; i < parent.children.length; i++) {
    const ch = firstVisibleChar(parent.children[i]);
    if (ch) return ch;
  }
  return "";
}

/** 在 , . ; : ! ? 后补英文空格（带词内/URL/时间等保护）；`boundary` 为节点后的可见字符。 */
function insertSpaces(s: string, boundary: string): string {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    out.push(ch);
    if (!SPACE_PUNCT.includes(ch)) continue;
    const prev = i > 0 ? s[i - 1] : "";
    const next = i + 1 < s.length ? s[i + 1] : boundary;
    if (!next) continue;
    if (NEXT_SKIP.test(next)) continue; // 已带空格/相邻标点/闭括号
    if (WORD_RE.test(next) && WORD_RE.test(prev)) continue; // 3.14 / package.json / 10:30 等词内
    if (next === "/") continue; // URL / 路径分隔
    out.push(" ");
  }
  return out.join("");
}

/** 单个文本节点：全角转半角，再补空格（含节点边界）。 */
export function normalizeTextNode(value: string, boundary: string): string {
  const mapped = containsCJK(value) ? value.replace(FULLWIDTH_RE, (ch) => FULLWIDTH_MAP[ch]) : value;
  return insertSpaces(mapped, boundary);
}

/** remark 插件：遍历 mdast 全部 text 节点，按节点边界做规范化。 */
export const normalizeMdast: Plugin<[], Root> = () => (tree) => {
  visit(tree, "text", (node, index, parent) => {
    if (index === undefined || parent === undefined) return;
    node.value = normalizeTextNode(node.value, nextVisibleChar(parent, index));
  });
};
