# 实现状态与工程审计

当前记录基于 `9839c79`、2026-10-01修复工作树及2026-10-05至2026-10-08的提交重试、Canvas 保存一致性、CLI 工具执行器、本地引擎精简和工具事务收敛实现。审计对象包括 `agent/`、`shell/`、`frontend/`、`tests/`、构建配置和设计文档；文末按日期保留历史实施记录，历史验证结果只代表对应快照。

## 结论

项目的核心分层、模型回合重试、会话提交屏障、项目历史分页和统一消息状态已经落地。本轮按用户确认的持久化凭据方案保存多组 Provider，加上连接 origin 校验与不可变运行配置；同时修复主动取消后的工具结算、Canvas 未执行调用结算、工具批次原子提交、早期数据库迁移和输出预览竞态。下文继续保留尚未完成的安全、恢复预算和虚拟消息流问题。

| 领域 | 状态 | 结论 |
| --- | --- | --- |
| Agent / Provider / Tool / Memory 分层 | 已实现 | Runtime 保持唯一模型入口，Provider 负责协议归一化，工具通过注册表执行。 |
| User / Assistant / Tool 持久化屏障 | 已实现 | 稳定消息在本地提交成功后才进入下一阶段和模型上下文。 |
| 模型响应分类与有限重试 | 已实现 | 不完整 attempt 不进入稳定上下文，重试仍由主循环统一发起。 |
| 历史分页、投影与实时事件合并 | 已实现 | 持久化记录和 AgentEvent 汇入同一个 AgentState 与 MessageStream。 |
| 工具执行账本与恢复 | 部分实现 | 四阶段账本、主动取消事实、未执行结算与原子批次已接入；恢复预算和独立人工确认交互仍需完善。 |
| Provider 凭据 | 已实现 | 各 Provider 的密钥使用 `safeStorage` 加密存入 JSON；保存与发现均拒绝跨 origin 自动复用，模型连接保留一致的 URL/密文快照。 |
| Electron 安全边界 | 部分实现 | 已启用 context isolation、sandbox 并关闭 node integration；缺少导航、IPC sender、CSP 和外链协议约束。 |
| Canvas | 保存协调、版本冲突保护、Use selection 与 `canvas_edit` 已实现 | 编辑器提供真实文档版本；项目协调器合并草稿并等待保存确认；Main 比较 revision 与内容指纹、保持资源完整性。隔离 Electron 回归覆盖冷启动、焦点、实时编辑、冲突控件和重载。完整工作台窗口关闭与外部工具连接属于后续验收与接入。 |
| 测试与发布工程 | 部分实现 | 类型门禁覆盖 Main、工作台、真实 Canvas engine 及 Agent/Shell 测试；macOS 开发启动器和当前架构本地应用包统一使用 I 名称与本地签名，CI 和正式分发签名、公证流程继续完善。 |

## 本次项目历史迁移

- 项目历史使用 `projects`、`project_context`、`entries.project_id` 和 `tool_invocations.project_id` 组织。
- `project_id = NULL` 表示持久化的无项目历史范围。
- `HistoryRecorder` 维护项目或无项目范围的消息提交、草稿刷新和工具恢复账本。
- Composer 顶部项目选择行连接 Main 的目录选择、项目恢复和历史范围切换。
- 项目目录树通过 `project_context` 缓存，并作为有界 transient context 加入项目范围的模型请求。
- 既有 session-based SQLite 数据迁移到无项目范围，消息 payload、run/turn/tool 身份和恢复字段保持完整。

## 2026-10-01 修复结果

- Provider：现有 JSON 按 `providerProfileId` 独立保存名称、Base URL、加密密钥和模型目录。Main 与 Renderer 共用 origin 规则；协议、主机或端口变化后须显式输入密钥，同 origin 的路径调整允许复用。`resolve()` 捕获同一连接的 URL 与密文，后续编辑不改变已启动运行的连接。
- 主动取消：schema v9 的 `run_cancellations` 保存用户取消事实；Stop 在发出 AbortSignal 前记录该事实，每次工具进入物理执行前再次检查。尚未开始的调用结算为 cancelled；不确定的已开始调用保留证据并结算为 interrupted，后续运行通过 Tool Message 读取结果。
- 初始任务刚收到 ACK 就被停止时，Runtime 按原 `inputId` 将其归档为 interrupted，并把 ID 放入 `runCompleted.unappliedInputIds`；实时界面与重启历史都可呈现未应用任务和重发入口，该文本保持在模型 snapshot 之外。
- Canvas 恢复：`resumePlanned: false` 的调用使用显式“未执行结算”路径进入 `outcome_ready`，保持 `attemptCount = 0`；恢复过程不伪造一次物理执行，也不会因 `planned` 状态冲突持续阻塞新 run。
- 工具批次：完成的 Assistant Message 与本批全部 `planned` invocation 在一个 SQLite 事务中提交；中途失败整批回滚，保留原有草稿。每条调用保留独立的 `resultEntryId`、输入校验值和原始顺序。
- 旧库迁移：识别没有 `tool_invocations` 的早期 sessions 数据库；迁移原消息与身份，创建空账本。已有工具记录的版本继续完整迁移，项目范围数据库升级到 v9 后增加取消事实表。
- 输出预览：Renderer 用 `runId + fileId + updatedAt` 和请求代数控制预览与 loading；选择变化立即隐藏旧内容，迟到结果、迟到错误、空列表和卸载均有明确失效规则。IPC rejection 进入当前文件的可重试错误状态。

## 本轮验证（2026-10-01）

- Provider、工具生命周期/迁移/Main Stop 和预览定向测试合计75项，全部通过。
- 最终源码快照的 `npm run typecheck` 与生产构建通过；构建在隔离副本中执行。
- 同一快照的全量测试共244项：240通过、4失败。失败仍是此前审计识别的两条消息分组断言、搜索范围断言和 CSS selector 提取断言；本轮按用户指定列表没有改动这些契约或测试。
- 34份 Markdown/MDX 的相对链接、7个导航 JSON 和本轮差异格式检查通过。
- 取消、恢复与迁移使用隔离数据库和模拟工具验证；完整工作台中按钮到磁盘、Renderer 的实际交互仍属于后续验收范围。

## 2026-10-05 本地提交重试与验证

- 完整模型响应的本地提交由 Runtime 有限重试，同一响应、Assistant 身份、checkpoint 和工具结果身份保持不变；不重新请求模型，不在保存前启动工具。默认最多3次提交，两次退避为250ms、500ms。
- Repository 根据 SQLite 主错误码识别临时锁冲突，只允许未开始或已确认回滚的事务重试。永久错误、次数耗尽和回滚不确定仍明确失败；Stop 中止退避，并在刚完成的提交与工具执行之间再次检查取消。
- Recorder 支持未成功写入的终态草稿重新提交；草稿错误按 attempt 保留、在对应写入成功后清除；消息一致性按持久化 JSON 语义比较。
- 已简化冗余样式断言并合并表驱动用例，全量用例由244项调整为228项；本轮增加5组提交重试回归后为233项：230通过、3失败。既有失败分别是两条 steer 时间线断言和一条搜索索引范围断言。
- Runtime、SQLite、工具生命周期与 Main Stop 聚焦测试44/44通过；源码 node/web 类型检查、两份提交重试相关测试的 strict TypeScript 检查通过。覆盖真实 SQLite BEGIN/COMMIT 锁冲突、草稿更新、响应身份、次数耗尽、永久错误和 Stop；本轮未重新生成生产构建或执行完整工作台 Electron 交互验收。

## 2026-10-05 Canvas 实时编辑与保存一致性

- 编辑器通过 `getDocumentVersion()` 比较有序元素版本、删除状态、层级索引和图片资源；重绘缓存 nonce 继续负责绘制。CanvasSurface 在初始化完成的首个 `onChange` 建立内容与持久视图基准，随后开放模型命令与交互。
- `CanvasSaveCoordinator` 为每个项目捕获固定身份，集中拥有最新草稿、generation、保存版本和单一进行中请求。连续编辑合并成最新快照；`flush()` 等待目标 generation，提交时复制快照，应答确认对应版本。
- Main 保存协议使用 `expectedVersion: { revision, fingerprint }`。SHA-256 指纹比较规范化场景与资源元数据；基准分歧返回冲突，相同内容确认既有 revision，图片资源在成功应答前完成验证或补齐。资产准备后再次核对磁盘版本，非法存储字段保持原文件并返回错误。
- Canvas 冲突状态保留本地草稿与磁盘场景，提供独立导出草稿和显式重新加载。模型工具区分 `persistence_conflict`、`persistence_failed` 与元素冲突；成功批次通过请求开始时捕获的协调器等待保存确认。
- 桌面 Runner 在 Canvas 工具可用时提供实时编辑路由指令。应用内 Agent 通过已有工具循环调用 `canvas_edit`，场景文件与图片资源由应用保存链维护；外部 Agent 的本地命令连接属于后续独立接入能力。
- 定向回归45/45通过，包含真实 Electron 中的编辑器和 CanvasSurface 冷启动、焦点重绘、模型命令、冲突控件与重载。Renderer 保存端口使用受控替身；Main 保存与协议集成使用真实临时文件，模型路由使用本地模拟 Provider 与隔离 SQLite。
- 最终源码的 node/web 类型检查、隔离目录生产构建和差异格式检查通过。全量测试266项：263通过、3项既有失败，分别为两条运行中补充消息时间线断言和一条搜索索引范围断言。
- 严格写入顺序覆盖 Main 队列中的参与者；独立文件写入在加载与保存边界核对版本。完整工作台窗口关闭、系统文件对话框与外部工具接入继续按独立验收场景推进。

## 2026-10-06 Canvas CLI 工具执行器

- 模型继续使用 `canvas_edit` 的操作 JSON 契约。工具适配器调用 Host 注入的 `CanvasCliExecutor`，执行器启动固定的 Canvas CLI `apply` 命令并通过 stdin 提交操作。
- CLI 的父子进程 IPC 连接归属本次工具调用。Main 保留固定 Run、项目、窗口、引用与图片资源，核对 CLI 操作与调用快照一致后，复用 `CanvasEditBridge → CanvasSurface → applyCanvasEdit → flush()` 链路；CLI 输出经核对后回填原有 Tool Message。
- 执行器管理单批次接收、16 MiB 输入/结果边界、25秒确认期限、取消和应用退出。已提交异常报告 `outcome_unknown`，模型请求用户核对效果并提供新引用；工具继续采用当前调用账本与恢复策略。结果传输投影为约定字段，场景构造与资源持久化继续归属既有模块。
- 生产构建生成 `out/main/index.js`、`out/main/canvas-cli.js` 与共用协议模块；真实 Electron 的 Node 执行模式验证 CLI 可运行。CLI 使用应用执行器提供的父进程连接，独立外部客户端连接继续作为专门接入能力。
- Canvas CLI、工具路由与保存链定向回归40/40通过，覆盖真实子进程、保存确认等待、文字原样传输、作用域冻结、冲突、取消、超时、错误结果身份与生命周期。node/web 类型检查、隔离生产构建、文档链接及差异格式检查通过。
- 全量测试277项：274通过，3项既有消息时间线/搜索断言继续失败。回归与构建使用临时数据及隔离产物；完整工作台端到端与正式安装包继续按各自验收范围推进。

## 2026-10-07 本地 Canvas 引擎精简

- 产品能力按核心绘图工具、编辑命令、选区引用和导出边界收敛。Library、协作跟随和远端光标、图表粘贴、统计面板、旧 AI 生成插件、远程 iframe 执行、命令面板、网页遥测及其状态/API/事件接线完成源码移除。历史 iframe、embeddable 和 magic-frame 记录继续使用静态几何与占位标签。
- 本项目采用 `tests/` 中的 Node/Electron 回归；112 个旧测试、快照与配套 fixture/helper 完成库存清理。引用图确认的独立孤岛组件、旧字体菜单、开发字体源和服务端专用字体完成移除；旧字体编号9按系统默认字体恢复。
- 英语字典静态参与构建，中文、emoji 和已有文档的运行字体与 CJK 字形分片继续保留。53 个非英语语言 chunk 从生产构建移除；依赖声明同步移除原生 provider SDK、未使用脚本工具、PWA/旧浏览器 polyfill 和废弃命令搜索库。
- 引擎目录由765个文件减至528个；按 `.ts/.tsx/.js/.jsx/.scss/.css/.json/.md/.mdx/.snap` 的同一口径，文本由193,504行减至72,774行，减少120,730行（约62.4%）。旧测试/快照清理降低维护库存，运行模块与语言 chunk 清理同时降低发布资源。
- `npm run typecheck` 同时执行 Main、工作台和引擎独立类型检查。第三方开发类型、拥有独立 ArrayBuffer 的二进制接口、视口状态与输入回调边界补齐后，三项门禁均通过。
- 隔离 Electron 回归覆盖工具/底部布局、核心形状、JSON/剪贴板/PNG/SVG 元数据、真实中文输入及emoji/ZWJ提交、历史字体和 CJK 字形嵌入、旧语言回落、焦点与保存、磁盘冲突与重载、产品工具边界和历史嵌入静态兼容。全量测试280项：277通过，3项既有失败仍为补充消息时间线与搜索索引断言。隔离生产构建与差异检查通过。
- 来源与许可记录继续保留。项目本地维护绘图核心与定制模块；代码来源表示作者与复用关系，Git哈希表示本地版本身份。删除的跟踪文件可从Git恢复，包含已有改动的图表源码及专用字体另保留临时恢复副本。

## 2026-10-07 工具缓存、历史投影与 ripgrep 搜索

- Recorder 的工具去重索引按 `(runId, toolCallId)` 识别调用，队列内核对结果 entry 身份与内容。数据库提交成功后更新缓存与 completed snapshot；相同调用在写入失败后使用原 entryId 重提。
- HistoryService 每页批量关联已有 invocation outcome，核对项目、run、turn、toolCall 与 resultEntryId。Main 对实时与历史共用公共结果投影，Renderer 恢复原始输出、返回码、截断标记与错误分类；旧文本记录继续沿用文本展示。
- `find_files` 与 `search_content` 使用精确版本 `@vscode/ripgrep@1.18.0` 提供的当前平台引擎，按完整候选范围增量查询，扫描数覆盖20,000个文件及其后续文件。搜索保留字面关键词语义，使用原生 context 与忽略规则，工具定义与执行统一交付全部匹配。输出、匹配行、协议帧与 stderr 按实际数据完整保留。分块缓冲在完整帧处一次组装，取消终止子进程并保存部分结果说明。
- 本轮新增31项回归，缓存、历史与搜索均通过定向验证；node、web、Canvas 类型检查和新增测试的 strict 类型检查通过。隔离工作目录中的生产构建通过，Electron Node 执行模式成功启动依赖提供的 ripgrep；当前工作树原有构建产物保持原状。
- 全量测试311项：308通过，3项既有断言继续失败，分别为两条运行中补充消息时间线／活动组断言与一条界面搜索索引断言。历史关联覆盖分页、scope、稳定调用身份、结构化结果、旧记录与损坏结果；搜索覆盖真实 binary、配置隔离、特殊字符、上下文、忽略规则、扫描数、完整结果和取消。

查询完整结果交付的追加定向验证共30项，全部通过，覆盖超过100条匹配、超过64 KiB总输出、超过256 KiB的完整匹配行、超过300字符的 Unicode 内容、完整 stderr、参数指定的上下文、搜索工具定义与全量结果的一致性、取消与进程错误。Node 源码及查询测试的 strict 类型检查通过。

## 2026-10-08 工具执行事务与类型契约收敛

- Assistant 终态统一通过 `finishAssistantAttempt(context, status, message, plans)` 提交。Repository 在同一事务中完成 Assistant 终态与可选整批 planned 调用；普通回答使用空计划。终态准备和草稿 revision 读取归属同一串行队列，已排队的 streaming 刷新保持自己的阶段。
- `commitToolResult` 在同一事务中保存 Tool Message 与该 invocation 的 completed，核对稳定身份和已保存结果。正常执行与重启恢复共用结果物化函数，outcome_ready 保存确定 ToolResult 并支持原结果重提。有限保存重试复用同一结果与身份，物理执行始终位于保存重试范围之外。
- Write/Edit 在每次真实尝试边界准备一次完整目标字节与 checkpoint。执行意图事务同时保存证据、effect_pending 与 attemptCount；执行闭包发布同一份准备字节。工具共用同目录独占 staging、权限保留、文件 fsync、rename 和目录 fsync 发布器，v1/v2 证据按原始字节和可验证状态恢复。新目录链从子目录同步到准备时记录的既有祖先，恢复成功在文件与目录同步确认之后进入结果物化。
- Recorder、Repository 和工具参数指纹共用标准 JSON 规范化。持久化入口验证消息、工具结果、checkpoint 与结果状态；读取消息验证 payload 版本，工具恢复器验证私有证据。模型结果消息共用格式化函数，实时事件与历史公共投影沿用既有协议。
- 在线执行与重启恢复按持久化前序 outcome 决定后序 planned 调用的许可，completed/interrupted 结果继续阻止后序副作用。执行意图事务再次核对前序许可与取消事实；取消屏障拒绝采用独立调度类型进入 cancelled 结算。恢复参数对照指纹与源 Assistant，损坏记录通过存储错误保留开放阶段。
- 默认类型门禁加入 Agent/Shell 测试的 strict 检查；全量测试434项全部通过。真实临时文件与 SQLite 回归覆盖同文件连续 Edit、执行意图保存失败、rename 后结果保存中断、同步完成前的账本屏障、锁冲突、延迟草稿、符号链接、权限、取消、参数损坏与 staging 清理。
- Main、工作台、Canvas engine 和测试类型检查通过；隔离目录生产构建通过；Electron Node 执行模式下文件发布、批次恢复、取消与结果物化96项全部通过；差异格式检查通过。构建产物生成于隔离目录，当前工作树原有产物保持原状。

## P1：高优先级工程问题

1. **人工确认交互与恢复预算。** Runtime 将无法自动恢复的调用和后续依赖调用结算为 interrupted/skipped；`attemptCount` 记录尝试次数。独立人工确认界面与明确的 `maxRecoveryAttempts` 属于独立治理项。
2. **Canvas 完整工作台生命周期验收。** 项目保存协调、指纹冲突保护和受控 Electron 的冷启动/焦点/模型编辑/冲突重载已有回归覆盖。继续验证完整工作台中的快速切换、连续拖动、AI/用户同元素修改冲突、窗口关闭期间的末次防抖保存和系统附件对话框。
3. **Composer 与运行中输入交互回归。** 当前已等待 ACK 后清理对应草稿，App 捕获 IPC rejection 并回到失败状态；继续验证真实窗口中的连续补充输入、停止与重发。
4. **Bash 输出和进程生命周期无界。** stdout/stderr 先全部积存在 Main 内存，结束后才截断；取消只杀直接 Bash，目录快照每次前后全量扫描且不响应取消。改为有界 ring buffer + 流式 spool、进程组/Job Object、可取消的增量产物跟踪和退出 deadline。
5. **长会话没有上下文预算。** Recorder 冷启动读取全部 entries，每次模型请求复制全部 completed messages；搜索和 MessageBlock 派生也随完整历史增长。增加 token-aware Context Builder、成对保留 tool call/result 的压缩摘要、增量搜索索引和按需派生。
6. **虚拟布局高度不准确。** 消息虚拟块的外部 margin 不在 ResizeObserver border-box 内，误差随历史累计；首次吸底还依赖测量副作用。把间距移入被测 wrapper，以首个可见 `blockId + offset` 恢复锚点，并增加真实长历史 DOM 测试。
7. **模型输出与工具输出缺少统一敏感信息策略。** Provider 原始错误、Bash 输出和 tool_result 可把 Token 或私有内容写入事件、SQLite 与无生命周期临时文件。引入统一脱敏、受限诊断日志、TTL 清理和会话删除/保留策略。

## P2：工程治理与可维护性

- 活动组在 steer ACK 后就会生成新的空工作块并转移实时计时；设计要求在输入应用并启动后续回合后转移计时，该交互仍待调整。
- 折叠内容仅视觉隐藏，内部按钮仍可能进入 Tab 顺序；局部展开状态会在虚拟卸载后丢失。
- Read 的整文件读取与输出边界继续作为文件读取工具的独立资源治理项。Query 的搜索引擎与结果完整性规则见2026-10-07实施记录。
- 同步 SQLite `DatabaseSync` 与 `synchronous=FULL` 位于 Electron Main；长写入会阻塞 UI/IPC，应迁到单写者 worker/utility process。
- 消息 payload 与 SQLite schema 在解码和迁移入口分别检查版本，未知版本通过明确存储错误报告。
- 默认 typecheck 覆盖 Main、工作台、真实引擎和 Agent/Shell 测试；源码与执行边界测试共享严格类型契约。
- OpenAI-compatible 实现已完成未使用原生 provider SDK 依赖清理，历史 Provider 元数据与协议归一化继续保留在各自边界。
- 此前依赖审计报告 2 high、7 moderate，属于历史快照结果；后续依赖治理应重新运行审计并评估可达性。
- 仓库仍包含生成物与本地缓存，源代码与可再生成产物应分离；旧 Canvas 提交的大量构建产物记录只代表当时的变更。
- 弹性滚动与 Canvas 编辑器布局已有真实 Electron 交互回归；App hydrate、发送拒绝、Canvas 保存、折叠焦点、搜索和虚拟锚点仍需完整工作台交互覆盖。预览异步结果归属已有受控 Promise 回归测试。
- `npm run package:mac` 使用 Electron Packager 生成当前 Mac 架构的本地 ad-hoc 签名应用；开发启动器和正式本地包共享名称、图标和缓存流程。后续发布工程包括 lint、format、coverage、CI verify、Developer ID 签名、公证及 App Store 发布身份。

## 已更新的设计事实

- Memory schema 为 v9；payload version 仍为 v1。
- 模型 `length` 终态会让整个 Assistant attempt 进入 interrupted/重试，不会执行或回填其中的工具调用。
- Query 当前只提供 substring 匹配和内置忽略目录，不提供正则或项目 `.gitignore` 解析。
- 页面历史分页、投影和虚拟渲染只归 Desktop 文档；Agent 流程只保留 Runtime、Recorder、Repository 和工具恢复边界。
- 产品结构包含 Canvas，共享右侧工作侧栏；搜索会按需加载更早的本地历史页。

## 此前快照的验证记录

- `npm run typecheck`：通过。
- `npm test`：158/158 通过。
- 隔离副本中的 `npm run build`：通过；输出约 13 MB。
- 32 个 Markdown/MDX 相对链接：全部可解析。
- 全部 `meta.json`：JSON 解析通过。
- `npm audit --omit=dev`：2 high、7 moderate。

这些结果证明当前代码在已有覆盖内可以编译、测试和构建，不证明 P0/P1 失败路径已经正确。

## 代码质量中值得保留的部分

- `runId → turnId → toolCallId → entryId` 的稳定身份贯穿 Runtime、持久化和 Renderer。
- User、Assistant、Tool Message 的本地提交屏障正确放在下一阶段之前。
- 模型重试与工具恢复在概念上分层，工具声明恢复能力、Runtime 负责统一决策。
- 历史与实时事件汇入同一个 AgentState 和 MessageStream，没有复制第二套渲染链。
- 弹性滚动把原生几何与视觉位移分离，并已有真实 Electron 回归。
- Canvas 使用懒加载、不透明 contextId 和单次 Run 上下文，没有把场景 JSON 直接写入模型历史。

后续工作优先处理 IPC 与资源加载安全边界，再推进恢复预算与人工确认、有界 I/O/模型上下文，以及前端长历史与测试工程。

## 2026-09-25 增量：运行中输入的接收与安全边界

- Composer 在当前 run 执行期间保持文本输入可用；同一个28px操作按钮根据草稿内容切换发送与中断。运行中发送通过 `activeRunId` 绑定同一 run；Main 在持久化待处理文本后返回 ACK，Renderer 随即显示普通用户气泡。
- Runtime 在完整助手消息与本批工具结果提交后消费输入队列，按接收顺序把用户消息写入历史并交给下一次模型请求。最终回答准备完成时使用同一门控确认队列归属；停止、失败与启动恢复把剩余输入归档为 interrupted 用户 entry。
- Memory schema 升至 v8，`pending_run_inputs` 以自增接收序号、独立 `inputId` 和项目范围保存待处理输入；事务将它转成 completed 或 interrupted 用户 entry。
- 当日 MessageStream 按输入批次展示用户气泡、过程块和模型回复；本记录描述当日展示与计时行为。
- 本轮验证覆盖 TypeScript 类型检查、192 个测试、生产构建和差异格式检查。真实 Electron 窗口中的连续输入、滚动位置与视觉状态列入交互回归验收。

## 历史实现记录：2026-09-25 至 2026-09-26

- 2026-09-25 的实现按输入批次建立独立过程块，完成状态显示 `Process`；计时从最近一批补充输入应用时刻开始。
- 2026-09-26 的 Renderer 以有序时间线承载同一 `runId` 的用户输入和助手 turn，并依据 `turnId` 分别建立助手块；reasoning 与工具活动归入对应回合的折叠内容。这一条目记录当时的实现状态。
- 2026-09-26 的 Runtime 使用 `runStarted` 建立 run 计时起点，将全 run 时长保存到最终 Assistant entry，并在 `runCompleted` 携带 `finalTurnId` 和 `finalDurationMs`。实时流将时长放在最终助手块；历史投影沿用持久化 entry 时长。
- 上述测试记录对应当时的实现快照：类型检查通过，前端测试 98/98，消息流与状态聚焦测试 35/35，运行时、SQLite 持久化和输入队列定向测试 24/24。真实 Electron 连续输入与虚拟滚动交互继续列入交互回归验收。

### 2026-09-26 消息流视图规范

- 同一活动组容纳多个模型 turn、工具请求和工具结果；工具调用后的后续模型请求沿用当前活动组。
- 初始用户输入锚定首组。Steer ACK 将补充输入插入阅读时间线；当前 turn 及其工具批次继续归属当前组。Runtime 应用这批输入并启动后续 `turnId` 后，后续助手活动更新以最后一条已应用输入锚定的新组。
- `RunState.timeline` 是分组的唯一顺序来源。Renderer 从相邻助手 turn 派生活动组，并在用户输入边界切分；当前组在首个 turn 开始前以稳定组 ID 展示活动行。
- run 运行期间，各组的活动文案统一为 `Working for`，当前组显示从 `runStarted` 起算的实时耗时。展开活动行按序显示 reasoning 正文和工具活动，reasoning 使用无标题 Markdown；最终助手回答位于该组折叠行下方。
- steer 建立后续活动组时，前组保留活动内容和 `Working for` 文案。成功完成后，只有包含 `finalTurnId` 的最终组显示 `Worked for` 与从 `runStarted` 到 `runCompleted` 的全 run 总时长。
- `runCompleted.finalTurnId`、`finalDurationMs` 与最终 Assistant entry 的 `durationMs` 标识最终回复及唯一时长；历史投影依据 `inputId`、`turnId` 与 `entryOrder` 恢复相同分组。
- 活动组折叠规范集中定义于[消息流视图设计](desktop/design/workbench/message-stream.mdx)。前后端代码已按该规范建立 steer 边界分组、嵌套活动内容和最终组时长归属。此次变更同步调整现有投影与渲染测试用例；真实 Electron 视觉与连续输入交互仍列入回归验收。
