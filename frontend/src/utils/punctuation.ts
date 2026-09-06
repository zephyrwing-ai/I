/**
 * 中文文本标点规范化 —— 纯函数、零依赖、幂等。
 *
 * 全局默认规则（无设置开关）：
 * 1. 文本不含汉字 → 原样返回（纯英文与纯代码天然不受影响）。
 * 2. 含汉字 → 所有全角标点转半角（，、→ , 等），每个半角标点后补一个英文空格。
 * 3. 保护：词内标点（3.14、package.json、goo.gl）与 URL/路径（https://example.com）
 *    不加空格，避免产生「3. 14」「go. o」之类的破坏；
 *    ``` 围栏代码块整体跳过，不转换不补空格。
 *
 * 使用位置：纯文本展示路径（MessageStream 用户消息气泡与复制行任务文本）；
 * 数据层与 IPC 一律不调用。模型输出的结构路径（mdast 级）见 punctuation-md.ts。
 */

/** 是否含汉字（CJK 统一表意文字 U+4E00–U+9FFF 及扩展 A 区 U+3400–U+4DBF）。 */
export function containsCJK(text: string): boolean {
  return /[㐀-䶿一-鿿]/.test(text);
}

/** 全角 → 半角映射表。 */
export const FULLWIDTH_MAP: Record<string, string> = {
  "，": ",",
  "、": ",",
  "。": ".",
  "；": ";",
  "：": ":",
  "！": "!",
  "？": "?",
  "（": "(",
  "）": ")",
  "【": "[",
  "】": "]",
  "“": "\"",
  "”": "\"",
  "‘": "'",
  "’": "'",
  "～": "~",
  "％": "%",
};

/** 全角标点匹配（一次性遍历替换）。 */
export const FULLWIDTH_RE = /[，、。；：！？（）【】“”‘’～％]/g;

/** ``` 围栏代码块：成对，或未闭合直至结尾；整体跳过。 */
const FENCE_RE = /(```[\s\S]*?(?:```|$))/g;

/** 补空格集合。 */
export const SPACE_PUNCT = ",.;:!?";

/** 标点后一字符为这些 -> 已带空格 / 相邻标点 / 闭括号等，改为不加（引号除外：`他说: "你好"` 要留空格）。 */
export const NEXT_SKIP = /[\s(),.;:!?)\]}]/;

/** 词内字符（ASCII 字母数字下划线）。 */
export const WORD_RE = /[\w]/;

/**
 * 规范化中文文本标点。幂等：normalizePunctuation(normalizePunctuation(x)) === normalizePunctuation(x)。
 */
export function normalizePunctuation(text: string): string {
  if (!containsCJK(text)) return text;
  // split 带捕获组：奇数下标为代码块区段，直接原样保留
  return text
    .split(FENCE_RE)
    .map((part, index) => (index % 2 === 1 ? part : normalizeSegment(part)))
    .join("");
}

/** 对非代码块区段：全角转半角，再补空格。 */
function normalizeSegment(segment: string): string {
  return insertSpaces(segment.replace(FULLWIDTH_RE, (ch) => FULLWIDTH_MAP[ch]));
}

/** 在 , . ; : ! ? 后补英文空格（带词内/URL/时间等保护）。 */
function insertSpaces(s: string): string {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    out.push(ch);
    if (!SPACE_PUNCT.includes(ch)) continue;
    const prev = i > 0 ? s[i - 1] : "";
    const next = i + 1 < s.length ? s[i + 1] : "";
    if (!next) continue;
    if (NEXT_SKIP.test(next)) continue; // 已带空格/相邻标点/闭括号
    if (WORD_RE.test(next) && WORD_RE.test(prev)) continue; // 3.14 / package.json / 10:30 等词内
    if (next === "/") continue; // URL / 路径分隔
    out.push(" ");
  }
  return out.join("");
}
