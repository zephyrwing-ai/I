# Agent Studio UI 设计

> 版本：v0.2 · 日期：2026-08-27
> 负责人：UI 设计
> 关联：`docs/UX-DESIGN.md`（交互结构）、`frontend/src/styles.css`（当前实现基线）

## 0. 文档边界

本文只定义界面“长什么样”。

- UX 决定设置入口放置、抽屉行为、搜索流程和状态含义。
- UI 决定图标、颜色、字体、尺寸、间距、组件外观、视觉状态和动效。
- 本文不定义 Provider 调用、IPC、Agent Runtime 或命令执行逻辑。

## 1. 视觉方向

关键词：安静、专注、可审计、工具感。

- 主视觉重心是对话文本和最终结果，而不是卡片堆叠。
- 使用深色编辑器式中性背景，蓝色只用于主要操作和焦点，绿/琥珀/红只用于状态语义。
- 减少大面积渐变、厚重阴影、连续胶囊标签和装饰性 macOS 假窗口 chrome。
- 对话消息使用平面分组与细分隔线；执行详情使用低对比度容器，避免每条命令都像独立卡片。
- 正文使用系统无衬线字体；命令、返回码和输出使用等宽字体。

## 2. 基础 Token

### 2.1 颜色

沿用当前 CSS 变量，并集中管理透明度：

```css
:root {
  --accent: #0a84ff;
  --success: #34c759;
  --warning: #ff9f0a;
  --danger: #ff453a;
  --bg: #f5f5f7;
  --surface: #ffffff;
  --surface-muted: #f0f0f2;
  --border: rgba(60, 60, 67, 0.16);
  --text: #1d1d1f;
  --text-secondary: rgba(60, 60, 67, 0.68);
  --text-tertiary: rgba(60, 60, 67, 0.48);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1c1c1e;
    --surface: #242426;
    --surface-muted: #2c2c2f;
    --border: rgba(255, 255, 255, 0.12);
    --text: #f5f5f7;
    --text-secondary: rgba(235, 235, 245, 0.72);
    --text-tertiary: rgba(235, 235, 245, 0.52);
  }
}
```

颜色语义不能只依赖颜色：状态同时使用文字、图标或形状。

### 2.2 字体

- UI：`-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Noto Sans SC", sans-serif`。
- 命令/输出：`"SF Mono", ui-monospace, Menlo, monospace`。
- 中文正文行高：1.7–1.8；英文 UI 行高：1.4–1.6。
- 标题 16–18px、正文 14px、辅助说明不低于 12px。

### 2.3 尺寸与间距

- 基础间距：4 / 8 / 12 / 16 / 24 / 32px。
- 标题栏高度：56px；composer 最小高度：56px。
- 输入控件高度：40px；主要按钮高度：40px。
- 图标按钮热区：40×40px；窄窗口不缩小热区。
- 对话内容列最大宽度：760px；执行输出可在内容列内横向滚动。
- 设置抽屉宽度：360px，窄窗口时占满可用宽度。
- 小圆角 8px；容器圆角 12px；避免所有元素使用 999px 胶囊。

## 3. 图标规范

图标属于 UI 规范；动作和位置由 UX 文档定义。

| 用途 | 图标 | 尺寸 | 文字替代/Tooltip |
|---|---|---:|---|
| 设置 | Lucide `Settings` | 18px | 设置 |
| 搜索 | Lucide `Search` | 18px | 搜索当前运行 |
| 添加 | Lucide `Plus` | 18px | 添加 |
| 发送 | Lucide `ArrowUp` | 18px | 发送 |
| 停止 | Lucide `Square` | 16px | 停止运行 |
| 展开/收起 | Lucide `ChevronDown` | 16px | 展开详情/收起详情 |
| 复制 | Lucide `Copy` | 16px | 复制命令 |
| 打开文件 | Lucide `ExternalLink` | 16px | 打开完整输出 |
| 成功 | Lucide `CheckCircle2` | 16px | 已完成 |
| 错误 | Lucide `AlertCircle` | 16px | 运行失败 |

要求：

- 使用同一套线性图标，不混用 emoji 和 SVG 风格。
- 图标按钮必须提供 `aria-label`；纯图标按钮默认有 tooltip。
- 图标颜色继承语义变量，不在组件内散落十六进制颜色。

## 4. 页面组件

### 4.1 Header

- 左侧显示产品名或当前任务标题；任务标题过长时截断并保留完整 tooltip。
- 中间或标题旁显示紧凑运行状态指示器。
- 右侧依次放置搜索、设置；运行状态不会通过大面积彩色背景抢占标题栏。
- 设置按钮使用 `Settings` 图标，不显示“设置”文字作为常态；窄窗口保留图标热区。

### 4.2 Search popover

- 宽度 320–420px，使用 `surface` 背景和轻阴影。
- 顶部为搜索输入，右侧显示匹配计数和上下跳转按钮。
- 匹配文本用 `accent` 的低透明度背景高亮；当前匹配使用实心强调边界。
- 空结果显示单行说明，不显示空白大面板。

### 4.3 Settings drawer

- 右侧抽屉带标题、关闭按钮和运行锁定提示。
- 分组顺序：模型连接 → 执行策略 → 工作目录。
- 字段标签使用 `text-secondary`；输入值使用 `text`；帮助文案使用 `text-tertiary`。
- 错误字段使用 `danger` 边框和就地说明，不用整块红色背景覆盖抽屉。
- 抽屉出现/消失使用 180ms ease-out；`prefers-reduced-motion` 时无位移动画。

### 4.4 Composer

- 固定在对话流底部，使用单一容器，不额外叠加底部状态栏。
- 左侧为 `Plus` 添加入口（本版本可显示为预留但禁用，不能伪装成已实现附件功能）。
- 中间是多行输入区，空态提示清楚说明发送快捷键。
- 右侧主要操作为圆角矩形按钮：运行时显示 `Square + 停止`，空闲时显示 `ArrowUp + 发送`。
- 输入区获得焦点时只显示一层清晰 accent ring。

### 4.5 Conversation stream

- 用户消息和 Agent 消息用不同对齐/背景表达，但不使用大气泡聊天装饰。
- Agent 进度摘要是普通正文；“执行详情”是可折叠的次级区域。
- 命令行使用 `prompt-symbol` 和 mono；状态文字与 `rc` 同行，输出在下方。
- 最终回答使用最高层级标题和正文对比，前面可有一个轻量完成图标。

### 4.6 Result states

| 状态 | 图标 | 主色 | 视觉处理 |
|---|---|---|---|
| 执行中 | `LoaderCircle` | warning | 只在当前动作显示 spinner |
| 成功 | `CheckCircle2` | success | 低饱和绿色文字/图标 |
| 部分完成/步数上限 | `AlertTriangle` | warning | 提示原因和下一步 |
| 已停止 | `Square` | text-secondary | 中性，不使用 danger |
| 失败 | `AlertCircle` | danger | 就地错误摘要和恢复按钮 |

## 5. 动效与反馈

- 抽屉：180ms，ease-out。
- 搜索定位：滚动到目标后 300ms 轻微高亮，不使用持续闪烁。
- 流式文本：节流更新；光标只在当前增量块显示。
- Spinner、pulse、caret 必须受 `prefers-reduced-motion` 控制。
- 禁止 `transition: all`；只声明需要动画的属性。
- 不用动画替代状态文本；状态必须在静态截图中也可理解。

## 6. 视觉验收清单

- 首屏是否明显看出底部是输入区、中间是对话区？
- 设置和搜索图标是否一眼可识别，且有 tooltip/读屏标签？
- 最终回答是否比命令输出更突出？
- 成功、失败、取消、上限是否不只靠颜色区分？
- 深色模式下辅助文本是否仍可读？
- 375px 宽度下按钮热区、输入区和抽屉是否完整？
