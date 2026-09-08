# 设计文档索引

`DESIGN.md` 是设计文档入口，不再承载页面或工程细节。当前文档按事实归属拆分为：

- [桌面端产品结构](./desktop/structure/workbench.mdx)：按真实页面组织软件包含的区块、内容与能力；导航顺序由 `meta.json` 管理。
- [桌面端设计](./desktop/design/workbench/index.mdx)：按真实页面组织完整设计；用户操作、视觉、Electron、Renderer、IPC、状态、本地数据和安全承诺都写入所属页面；设计令牌、标题栏、设置、消息流、Composer、侧边栏与安全边界按类别拆分到 `desktop/design/workbench/` 目录。
- [Agent 设计](./agent/architecture.mdx)：只按模型请求、运行循环、工具系统和 AgentEvent 等宿主无关模块描述 Agent 内核契约；具体工具目录位于 `agent/tools/`。

以上三类文档共同描述当前行为与明确标注的后续设计。未实现能力不能因出现在设计目录中就视为可用；各页面的实现对照入口用于核验代码。发生冲突时，先修正产品结构，再同步桌面设计和 Agent 设计；同一事实不维护平行副本，也不允许在原型代码中自行猜测。
