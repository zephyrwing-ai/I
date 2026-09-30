# 实现状态与工程审计

审计基线：`4f3f92a`（`add canvas`），2026-09-19。审计对象包括 `agent/`、`shell/`、`frontend/`、`tests/`、构建配置和全部设计文档。

## 结论

项目的核心分层、模型回合重试、会话持久化屏障、历史分页、统一消息状态和基础虚拟渲染已经落地；工具恢复、安全边界、凭据生命周期、Canvas 写入一致性和失败交互仍有阻断生产使用的缺口。因此当前状态不能判定为“完全按照设计实现”。

| 领域 | 状态 | 结论 |
| --- | --- | --- |
| Agent / Provider / Tool / Memory 分层 | 已实现 | Runtime 保持唯一模型入口，Provider 负责协议归一化，工具通过注册表执行。 |
| User / Assistant / Tool 持久化屏障 | 已实现 | 稳定消息在本地提交成功后才进入下一阶段和模型上下文。 |
| 模型响应分类与有限重试 | 已实现 | 不完整 attempt 不进入稳定上下文，重试仍由主循环统一发起。 |
| 历史分页、投影与实时事件合并 | 已实现 | 持久化记录和 AgentEvent 汇入同一个 AgentState 与 MessageStream。 |
| 工具执行账本与恢复 | 部分实现 | 四阶段账本存在，但取消结算、整批原子登记、恢复预算和人工确认没有闭环。 |
| Provider 凭据 | 未满足契约 | API Key 仍写入 Provider JSON；旧 Key 还能与 Renderer 提交的新 Base URL 组合。 |
| Electron 安全边界 | 部分实现 | 已启用 context isolation、sandbox 并关闭 node integration；缺少导航、IPC sender、CSP 和外链协议约束。 |
| Canvas | 项目持久化、Use selection 与 `canvas_edit` 已实现，交互回归待完成 | Main 按项目串行保存；Runner 仅为桌面 Run 添加 Canvas Edit；Renderer 在实时场景上执行原子命令，等待保存确认后回填工具结果。窗口关闭与并发冲突交互仍需验证。 |
| 测试与发布工程 | 部分实现 | 类型检查、155 个测试和生产构建通过；测试未进入 TypeScript 检查，且缺少 CI、交互回归和正式打包链路。 |

## 本次项目历史迁移

- 项目历史使用 `projects`、`project_context`、`entries.project_id` 和 `tool_invocations.project_id` 组织。
- `project_id = NULL` 表示持久化的无项目历史范围。
- `HistoryRecorder` 维护项目或无项目范围的消息提交、草稿刷新和工具恢复账本。
- Composer 顶部项目选择行连接 Main 的目录选择、项目恢复和历史范围切换。
- 项目目录树通过 `project_context` 缓存，并作为有界 transient context 加入项目范围的模型请求。
- 既有 session-based SQLite 数据迁移到无项目范围，消息 payload、run/turn/tool 身份和恢复字段保持完整。

## P0：发布阻断

### 1. 已保存 API Key 可以发送到新的 Provider 地址

问题链路：Provider 编辑器提交原 `providerProfileId` 和用户修改后的 `baseURL`；`ProviderStore.discoveryConnection()` 在 API Key 留空时复用旧 Profile 的密钥；模型发现随后把 `Authorization: Bearer` 发往新地址。当前界面没有要求连接 origin 变化后重新输入密钥。

证据：`frontend/src/components/ProviderEditor.tsx:86`、`shell/main/provider-store.ts:159-168`、`shell/main/provider-model-discovery.ts:184-203`。

解决方案：

- Main 只在 `providerProfileId + canonical origin` 完全一致时复用当前进程内的凭据；协议、主机或端口变化立即失效并要求重新输入。
- Provider 文件只保存元数据和模型目录，API Key 只存在于 Main 内存；重启后必须重新输入。
- Main 对所有 IPC 做可信 sender/frame、运行时 schema 和大小校验；禁止工作台顶层导航，外链只允许明确协议，并增加生产 CSP。
- 模型发现显式约束 redirect，任何 origin 变化都不能携带原 Authorization。

前端交互：连接 origin 变化时清空凭据可用状态、禁用 Fetch/Save，并提示用户重新输入；不得用“留空复用”掩盖凭据发送目标已经变化。

### 2. Stop 后剩余工具可能在下一次任务中自动执行

问题链路：Runtime 在执行前登记整批 ToolCall；取消时直接结束 run，却没有结算尚未执行的 `planned` invocation；下一次 `run()` 在提交新用户消息前恢复所有未完成 invocation，因此旧 Write/Bash 可能在新任务开始时产生副作用。

证据：`agent/loop.ts:167-180`、`agent/loop.ts:237-245`、`agent/loop.ts:413-468`、`agent/memory/session-recorder.ts:270-281`。

解决方案：持久化 run/batch 生命周期。主动取消时，在同一事务内把未开始调用结算为 `cancelled/skipped`；已经进入 `effect_pending` 的调用只允许核对真实状态，不能把主动取消当成崩溃后安全重放。下一次用户发送不得隐式触发旧批次。

前端交互：Stop 后显示稳定的 Cancelled；不确定副作用显示 Requires confirmation，并提供独立恢复入口。普通发送按钮不能承担恢复确认。

## P1：高优先级工程问题

1. **工具批次不是原子登记。** Assistant Message 已 completed 后，invocation 逐条独立写入；崩溃可留下零条或半批账本。增加 Repository 级 `commitAssistantAndPlanToolBatch()`，在一个事务中提交 Assistant 与整批 planned records；checkpoint 在每次真实 attempt 开始时生成。
2. **`never`、人工确认和恢复预算没有闭环。** 当前 interrupted 后仍会继续后续调用，`attemptCount` 只递增不限制。增加 `requires_confirmation`/blocked 状态、默认 skip 后续依赖调用和明确的 `maxRecoveryAttempts`。
3. **Write/Edit 不是原子发布。** 两者直接覆盖目标文件，却声明 reconcile。改为同目录临时文件、flush/fsync、原子 rename，并把 staging/backup 身份与 hash 写入 checkpoint。
4. **Canvas 生命周期与并发交互回归。** Main 按项目 ID 串行写入并使用唯一临时路径；Renderer 在项目切换前等待最新草稿保存，保存失败时保留画布与重试入口。`canvas_edit` 通过当前窗口的实时编辑器提交批次，并等待保存确认。后续真实 Electron 回归覆盖快速切换、连续拖动、AI/用户同元素修改冲突、窗口关闭期间的末次防抖保存和附件图片导入。
5. **Composer 失败会丢草稿。** 当前在 Main ack 前清空文本、附件和 Canvas；IPC reject 还会让页面停在 starting。`onRun` 应返回判别结果，仅在 ack 成功后清理；异常统一进入 `runRejected` 并保留草稿。
6. **Bash 输出和进程生命周期无界。** stdout/stderr 先全部积存在 Main 内存，结束后才截断；取消只杀直接 Bash，目录快照每次前后全量扫描且不响应取消。改为有界 ring buffer + 流式 spool、进程组/Job Object、可取消的增量产物跟踪和退出 deadline。
7. **长会话没有上下文预算。** Recorder 冷启动读取全部 entries，每次模型请求复制全部 completed messages；搜索和 MessageBlock 派生也随完整历史增长。增加 token-aware Context Builder、成对保留 tool call/result 的压缩摘要、增量搜索索引和按需派生。
8. **虚拟布局高度不准确。** 消息虚拟块的外部 margin 不在 ResizeObserver border-box 内，误差随历史累计；首次吸底还依赖测量副作用。把间距移入被测 wrapper，以首个可见 `blockId + offset` 恢复锚点，并增加真实长历史 DOM 测试。
9. **模型输出与工具输出缺少统一敏感信息策略。** Provider 原始错误、Bash 输出和 tool_result 可把 Token 或私有内容写入事件、SQLite 与无生命周期临时文件。引入统一脱敏、受限诊断日志、TTL 清理和会话删除/保留策略。

## P2：工程治理与可维护性

- 输出预览没有 request identity 或取消，A 的迟到响应可以覆盖已选中的 B。
- 历史投影直接修改旧的 RunState/TurnState，破坏不可变状态和后续 selector/memo 边界。
- 折叠内容仅视觉隐藏，内部按钮仍可能进入 Tab 顺序；局部展开状态会在虚拟卸载后丢失。
- Read/Search 先读取完整文件再限制输出；Query 达到总扫描上限时没有把“不完整”传回模型。
- 同步 SQLite `DatabaseSync` 与 `synchronous=FULL` 位于 Electron Main；长写入会阻塞 UI/IPC，应迁到单写者 worker/utility process。
- `payload_version` 未知值没有在解码前拒绝，schema 初始化也先执行当前 DDL 再判断未来 `user_version`；迁移必须先读版本、在事务中逐级处理，未来版本只读失败且不改库。
- 默认 typecheck 不包含 tests；当前测试替身已经出现生产接口漂移。建立 `tsconfig.tests.json` 并在 CI 执行 typecheck、test、build、docs/link 和 `git diff --check`。
- OpenAI-only 实现仍保留 Anthropic/Google SDK 与多余 Provider 状态，增加依赖与契约噪声。
- `npm audit --omit=dev` 报告 2 high、7 moderate，均位于 CanvasEditor 依赖链，需要可达性评估、升级或有期限豁免。
- 仓库追踪生成物、107 个 `tsx-501` 缓存、日志和 `.DS_Store`；Canvas 提交因此增加 182 个文件、约 22 万行。源代码与可再生成产物应分离。
- 当前只有弹性滚动具备真实 Electron 交互回归；App hydrate、发送拒绝、预览竞态、Canvas 保存、折叠焦点、搜索和虚拟锚点主要依赖 SSR 或纯函数测试。
- 缺少 lint、format、coverage、CI verify、Electron 打包、签名和公证流程；`electron-vite build` 只生成 `out/`，不等于可发布 macOS 应用。

## 已更新的设计事实

- Memory schema 为 v6；payload version 仍为 v1。
- 模型 `length` 终态会让整个 Assistant attempt 进入 interrupted/重试，不会执行或回填其中的工具调用。
- Query 当前只提供 substring 匹配和内置忽略目录，不提供正则或项目 `.gitignore` 解析。
- 页面历史分页、投影和虚拟渲染只归 Desktop 文档；Agent 流程只保留 Runtime、Recorder、Repository 和工具恢复边界。
- 产品结构包含 Canvas，共享右侧工作侧栏；搜索会按需加载更早的本地历史页。

## 验证结果

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

下一轮实现应先处理两个 P0，再按“原子工具批次与取消状态机 → 凭据/IPC安全 → Canvas/Composer 异步事务 → 有界 I/O 与上下文 → 前端长历史与测试工程”的顺序推进。

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
