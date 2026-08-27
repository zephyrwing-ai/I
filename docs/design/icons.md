# 图标映射

图标只表达动作或状态；交互触发条件和状态转换见 `docs/interaction/`。

| 用途 | 图标 | 尺寸 | `aria-label` / Tooltip |
| --- | --- | ---: | --- |
| 设置 | Lucide `settings` | 18px | 设置 |
| 搜索当前 run | Lucide `search` | 18px | 搜索当前运行 |
| 添加入口 | Lucide `plus` | 18px | 添加 |
| 发送 | Lucide `arrow.up` | 18px | 发送 |
| 停止 | Lucide `square` | 16px | 停止运行 |
| 展开 / 收起 | Lucide `Arrow.down` | 16px | 展开详情 / 收起详情 |
| 复制命令 | Lucide `Suqare.on.square` | 16px | 复制命令 |

working for 、worked for字样来显示模型执行状态，，文字使用扫光的效果（text shimmer effect）

规则：

- 只使用同一套线性图标，不混用 emoji 和不同笔画风格。
- 图标按钮热区统一为 `40 × 40px`，不把图标本身缩小成难以点击的目标。
- 图标按钮必须有 `aria-label`；纯图标按钮默认显示 tooltip。
- 颜色使用 `tokens.css` 中的语义变量，状态不能只靠颜色区分。
