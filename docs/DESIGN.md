设计文档索引。

- 入口：`DESIGN.md` 提供设计导航，页面细节与工程契约由各自所属的文档描述。
- 产品结构：[桌面端产品结构](./desktop/structure/workbench.mdx)按真实页面组织软件区块、内容与能力，导航顺序由 `meta.json` 管理。
- 桌面设计：[桌面端设计](./desktop/design/workbench/index.mdx)按真实页面组织用户操作、视觉、Electron、Renderer、IPC、状态、本地数据和安全边界；设计令牌、标题栏、设置、消息流、Composer 与侧边栏分别放在 `desktop/design/workbench/` 的所属页面。
- Agent 设计：[Agent 设计](./agent/architecture.mdx)按项目历史存储、上下文管理、模型请求、运行循环、工具系统和 AgentEvent 描述平台独立的内核契约；具体工具位于 `agent/tools/`，跨模块存储任务见[实现清单](./agent/session-storage-tasks.mdx)。
- 行为追踪：[模型请求](./agent/model-request.mdx)定义公开正文、原始推理和工具调用的协议映射，[运行事件](./agent/events.mdx)定义事实交付，[历史投影](./desktop/design/workbench/history-projection.mdx)定义实时与历史共用的状态映射，[消息流](./desktop/design/workbench/message-stream.mdx)定义过程文字、工具批次、阶段折叠和最终回答的展示契约。
- 文档格式：模块名称使用普通段落，设计条目使用“属性：说明。”的平铺列表；内容使用肯定句描述确定的职责、数据、状态、布局与交互，相关页面通过链接共享所属模块的规则。
- 维护：同一事实由所属页面统一维护；发生冲突时先修正产品结构，再同步桌面设计和 Agent 设计，原型与实现按对应契约衔接。
