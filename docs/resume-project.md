# 简历项目素材：Agent Studio（桌面端 AI 编程 Agent）

> 本文是**素材与写法建议**，不是要直接照抄的成品。每条事实都标注了对应的源码位置，方便面试答辩时指出"哪一行"。

---

## 0. 先给结论：你原来的思路对不对？

你说"写工具系统、画布系统"——**方向对，但颗粒度会吃亏**。

原因：`工具系统` 和 `画布系统` 是**功能名**，任何做过类似项目的人都能写；面试官看不到你的**技术判断力**。

建议改成**三条"工程难题"主线**，功能名降级为佐证：

| 原思路 | 建议改写为 | 为什么更有杀伤力 |
|---|---|---|
| 工具系统 | **长时运行 Agent 运行时的控制流与失败恢复** | 涉及重试分层、幂等账本、取消屏障、恢复预算，是真正的分布式/可靠性问题 |
| 画布系统 | **跨进程命令执行的一致性边界**（Renderer 持有真实场景，Main 持有权威） | 涉及子进程 IPC、身份校验、超时与 `outcome_unknown` 语义、乐观并发 |
| （你没提） | **十万量级消息历史的渲染与状态收敛** | 实时事件流 + 历史落盘汇入单一状态树，虚拟滚动 + 锚点恢复 |

一句话改成：

> 从零实现一个 Electron + React + TypeScript 的桌面 AI 编程 Agent：自研 Agent 运行时（模型/工具/记忆三层）、可被模型直接编辑的本地画布、以及流式对话工作台。

---

## 1. 可直接用的简历条目

### 版本 A：一页简历，4 条（推荐）

> **Agent Studio** — 桌面端 AI 编程 Agent（Electron + React + TypeScript，个人项目，自研代码约 1.4 万行 / 50 个测试文件、270+ 用例）
>
> - **自研 Agent 运行时**：实现"模型请求 → 工具调用 → 结果回填 → 续轮"的回合制循环，用 `runId → turnId → toolCallId → entryId` 稳定身份贯穿运行时、持久化与前端渲染；将**模型请求重试**（指数退避）与**本地提交重试**（不重复请求模型）拆成两层独立策略，并把工具自身声明的恢复能力（`safe` / `never`）交给运行时统一裁决。
> - **工具系统与幂等恢复**：设计声明式工具注册表（JSON Schema 入参 + 恢复策略版本），注册表内置 bash / read / write / edit / list_dir / find_files / search_content 七类工具，画布侧再注入 canvas_edit（共 8 个模型可见能力）；用 `tool_invocations` 账本 + `canonicalJson` + 输入哈希实现调用幂等与崩溃后恢复，大输出截断并落盘 spool，保证模型上下文不被单条命令淹没。
> - **画布系统（跨进程一致性）**：让模型通过 `canvas_edit` 的结构化操作契约（最多 32 个操作/批次）直接编辑用户正在看的画布；Main 以 `fork` 子进程 + 父子 IPC 执行命令（16 MiB 输入上限、25 s 截止时间），只在**结果来自发起 Run 的窗口**时接受回填，并区分 `cancelled` / `canvas_unavailable` / `outcome_unknown` 三种失败语义——不确定是否已生效时**不盲目重试，而是要求用户核对后提供新引用**。持久化侧用 revision 乐观并发 + 临时文件原子 rename + 保存协调器（防抖 / 串行队列 / 冲突保留本地草稿）。
> - **流式工作台与测试工程**：把实时事件流与 SQLite 历史投影收敛到**同一个 AgentState**，按用户输入边界对多回合活动分组；自研欠阻尼弹簧的解析解做越界回弹（按真实 dt 推进，跨刷新率视觉一致）；含真实 Electron 交互回归、快照测试与 `tsc` 双端类型检查门禁。

### 版本 B：详细版（放 GitHub README 或作品集）

按"问题 → 方案 → 权衡"写，见下面第 3 节，每个模块一条。

### 版本 C：极简版（简历只有一行）

> 独立设计并实现桌面 AI 编程 Agent（Electron/React/TS，1.4 万行自研代码）：自研 Agent 运行时与工具恢复机制、可被模型编辑的本地画布（跨进程命令执行 + 乐观并发持久化）、十万级消息历史工作台；270+ 自动化测试含真实 Electron 回归。

---

## 2. 技术栈一行

`TypeScript` · `Node.js` · `Electron` · `React 18` · `electron-vite` · `SQLite (node:sqlite / WAL 式单写者)` · `JSON Schema` · `Jotai` · `OpenAI 兼容协议（SSE 流式）` · `Canvas 2D / 本地绘图引擎定制` · `node:test` + `tsx`

---

## 3. 分模块素材（含事实依据，答辩用）

### 3.1 Agent 运行时 — `agent/loop.ts`（736 行）

**可讲的技术点**

1. **控制流**：回合制循环，`complete` / `tool_use` / `error` / `aborted` / `length` 五类终态分类处理；无工具调用即自然结束，**不设数值循环上限**（有意决策，与 `pi` 的控制语义对齐）。
2. **两层重试（亮点）**：
   - *模型请求重试* `maxAttempts 3, 1 s → 8 s` 指数退避；
   - *提交重试* `maxAttempts 3, 250 ms → 1 s`——**在本地重放同一次响应，不再打一次模型请求**（省 token、避免重复副作用）。
   - 这是"重试的边界该划在哪"的典型设计题，很适合展开讲。
3. **中断语义**：`length` 截断的 Assistant attempt 整体标记 `interrupted` 后重试，**不执行其中任何工具调用**，避免半截 JSON 触发误操作。
4. **取消屏障**：`cancellationBarrier` 保证 Main 先把 Stop 持久化，再 abort——"取消这个事实本身也必须落盘"。
5. **运行中补充输入（steering）**：`AgentSteeringInbox` 由宿主持有准入权，运行时**只在完整回合之间**取用；`takePendingOrSeal()` 是收尾时的门控读。

**可量化的点**：3 条独立重试策略、5 类终态、4 层稳定身份。

### 3.2 工具系统 — `agent/tools/`

**可讲的技术点**

1. **声明式注册表**：每个工具 = `ToolDef`（name / description / JSON Schema parameters）+ `execute` + **恢复策略**（`{ version, mode: "safe" | "never" }`）。
   - 技巧：**工具只声明能力，运行时统一裁决**——恢复逻辑不散落在各工具里，这是分层的关键。
2. **输入校验前置**：所有工具在入口做类型/范围校验，返回结构化错误码（`invalid_arguments` / `not_found` / `binary_file` / `target_is_directory`…），而不是抛异常。
3. **大输出治理**：`read` 默认 1000 行、上限 5000 行、单行 2000 字符截断，并返回 `nextStart` 让模型**分页续读**；`bash` 输出超限时落 `fullOutputPath`，模型只拿到摘要 + 路径。→ 讲"如何防止一次 `cat` 把上下文打爆"。
4. **多模态**：`read` 按扩展名识别图片，返回 `media.dataUrl` 而不是把二进制当文本打印。
5. **产物追踪**：`FileArtifact`（path / created|updated / mediaType / byteSize）结构化回传，绝对路径**永不进入 Renderer**，前端只拿得到投影后的 descriptor。
6. **幂等与恢复账本**：`tool_invocations` 表 + `canonicalJson` 规范化 + `toolInputHash` 做**同一逻辑调用的身份识别**，支持中断后重放决策。

**可量化的点**：8 类工具、默认/上限行数、错误码枚举、账本表结构。

### 3.3 画布系统 — `canvas/` + `shell/main/canvas-*.ts`（重点，差异化最强）

这是整个项目**最难也最值得写**的部分：模型要改的是**人类正在看的活对象**，跨了 3 个进程、2 种所有权。

**可讲的技术点**

1. **操作契约**：`canvas_edit` 用结构化 JSON 描述操作（create / update / delete / duplicate / reorder / flip / setLocked / group / ungroup），单次最多 32 个操作、基础元素上限 1000。模型不写代码，只提交声明。
2. **执行链路（4 跳）**：
   `模型 tool_call → Main 侧 CanvasCliExecutor → fork 出 Canvas CLI 子进程（父子 IPC 传输）→ Main 的 CanvasEditBridge → Renderer CanvasSurface → applyCanvasEdit → flush()`
   → 每一跳都保留 Run / 项目 / 窗口 / 引用身份，**层与层之间只传约定字段**。
3. **一致性设计（最能体现功力）**：
   - CLI 的 IPC 连接**归属本次工具调用**，不复用；
   - 结果**只接受来自发起 Run 的 `ownerWebContentsId`** 的窗口；
   - 边界常量：16 MiB 输入、25 s CLI 截止、20 s Bridge 超时、单批次单接收；
   - 失败三态语义化：`canvas_unavailable` / `cancelled` / **`outcome_unknown`**——最后一个表示"可能已经执行了"，此时**不重试**，而是把结论回填给模型并要求"请用户核对效果并提供新引用"。这是**at-most-once vs at-least-once** 的取舍，面试里非常能聊。
4. **引用不透明化**：`CanvasContextRegistry` 给画布选区发**不透明 `contextId`**（10 分钟 TTL，最多 32 个），严格校验"选中 ID 集合 == 快照元素集合"，模型侧 JSON ≤ 512 KB、视觉 PNG ≤ 8 MB，**图片二进制在进入模型前被剥离**（只留 `fileId`）。→ 讲"如何避免把整个场景 JSON 灌进模型历史"。
5. **持久化并发控制**：`CanvasDocumentStore` 按 project scope 分目录，文档带 `revision`，**乐观并发 + 临时文件 + rename 原子写**，图片资源与文档分离存储（单文件 ≤ 4 MB、≤ 1000 文件、≤ 2 万元素）。
6. **保存协调器** `CanvasSaveCoordinator`：防抖 + `generation` 计数 + **串行写队列** + `flush()` / `dispose()` 生命周期契约；冲突时抛 `CanvasSaveConflictError` 并**保留本地草稿**，不静默覆盖用户成果。

**可量化的点**：9 类操作 / 32 操作上限 / 16 MiB / 25 s / 10 min TTL / 32 个引用 / revision 乐观并发 —— **这类具体数字最能撑起"工程严谨"的印象**。

### 3.4 记忆与持久化 — `agent/memory/`（sqlite-repository 752 行）

- **SQLite schema v10**，含**版本化迁移**（`PRAGMA user_version` + 未来版本直接拒绝启动）。
- 表：`projects` / `project_context` / `entries`（含 `payload_version`）/ `pending_run_inputs` / `tool_invocations` / `run_cancellations`。
- **条目状态机**：`completed` / `interrupted` / `failed`，事务化把待处理输入转成 user entry。
- `SessionRecorder` 提供"已提交消息快照"，冷启动重建历史。
- 自我认知清楚：文档里已记录"同步 `DatabaseSync` 在 Main 会阻塞 UI，应迁到单写者 worker"——**面试时主动说出自己项目的已知缺陷，是加分项**。

### 3.5 前端工作台 — `frontend/src/`

- **单一状态源**：实时 `AgentEvent` 与 SQLite 历史投影（`sessionProjection`）汇入**同一个 `AgentState` reducer**，不维护第二条渲染链路。→ 讲"历史与实时视图不一致"这类经典 bug 怎么被结构性地消灭。
- **分组规则**：`buildMessageBlockRecords` 用**用户输入作为唯一边界**切分活动组，相邻 assistant turn 合并；`finalTurnId` 决定"哪个回合显示总时长"。
- **弹性滚动**：`useElasticScroll` 用**欠阻尼弹簧解析解**（`springStep`）按真实经过时间推进 → 不同刷新率共用同一条运动曲线；含边界分类（`outward` / `inland` / `within`）与手势间隔判定，内部滚动区优先消耗自身余量。
- **虚拟滚动**：`useVirtualMessageWindow` + `ResizeObserver` 测量，锚点按 `blockId + offset` 恢复。
- **Markdown 渲染**：GFM + 换行 + 中英标点/排版规则（`punctuation.ts`）。

### 3.6 安全与边界 — 值得单列一条

- **绝对路径不进 Renderer**（`FileArtifact` 注释里明确写了这条约束）；
- **Provider 凭据不进 Renderer**：Main 侧持有 `encryptedApiKey`，通过**系统凭据加密**（`codec.available()` 不可用时**拒绝保存**而不是降级明文）；
- 所有跨进程输入都有尺寸/格式校验（`isRecord` / `isCliRequest` / `isCliReply` 手写类型守卫，因为进程边界上的 JSON 不可信）；
- 画布上下文有 TTL 与数量上限，避免内存泄漏与引用泄漏。

### 3.7 工程素养 — 一个容易被忽略的加分项

这个仓库有一套**成体系的 MDX 设计文档 + 实现状态审计**，其中 `docs/IMPLEMENTATION_STATUS.md` 是自己给自己列的风险清单（P0/P1/P2），例如：

- Write/Edit **不是原子发布**（直接覆盖 + 声明 reconcile），应改临时文件 + fsync + 原子 rename；
- Bash 输出与进程生命周期**无界**，应改 ring buffer + 流式 spool + 进程组；
- 长会话**没有上下文预算**，应加 token-aware Context Builder；
- 虚拟布局高度**不准确**（margin 不在 border-box 内，误差随历史累计）。

**面试时把这段拿出来讲**：说明你不仅会实现，还会**主动做技术债分级和验收边界标注**。这比多写两个功能更能打动面试官。

---

## 4. 不要写 / 要小心写的内容（诚实边界）

| 别写 | 原因 | 可以怎么写 |
|---|---|---|
| "支持多模型 Provider（OpenAI/Claude/Gemini）" | 当前能力是 **OpenAI 兼容协议**；原生 Provider SDK 已完成依赖清理 | "实现 OpenAI 兼容协议适配层，流式事件归一化为统一消息/停止原因" |
| "Canvas 引擎全部自研" | 绘图核心来源为 MIT 编辑器快照；2026-10-07 精简后引擎文本约 **7.28 万行** | "基于 MIT 绘图核心精简本地引擎，独立实现画布命令链路、上下文引用和项目持久化" |
| "实现了文件系统沙箱" | 文档明确写了 cwd **不构成沙箱** | "工作目录仅决定路径解析与命令启动位置；沙箱属宿主职责，未实现" |
| "测试全绿" | 有 3 条既有失败用例（消息时间线/搜索断言） | "277/280 通过，3 条已知失败已登记" |
| "支持正则 / .gitignore 的搜索" | 当前只有 substring + 内置忽略目录 | "实现增量 substring 搜索索引" |
| 编造性能数字（QPS、延迟） | 项目里没有基准测试数据 | 用**边界常量**代替（16 MiB / 25 s / 32 操作 / 10 min TTL），这些是真的 |

---

## 5. 面试可能被追问（提前准备）

1. **"为什么模型重试和提交重试要分开？"** → 打一次模型请求有成本和副作用（可能已产生 tool_call），本地重放同一份响应不会改变模型侧状态；把"传输失败"和"本地落盘失败"混在一起重试会导致重复工具执行。
2. **"`outcome_unknown` 为什么不重试？"** → 命令可能已生效，重试会重复创建元素。宁可让用户核对，也不制造不一致。这是 at-most-once 的取舍。
3. **"跨了 4 跳怎么保证结果没串？"** → 每一跳都携带并校验 Run / 项目 / 窗口 / requestId；结果只从 owner window 接受；请求身份由 Main 生成。
4. **"为什么工具要声明恢复能力而不是统一重试？"** → `bash` 的副作用不可逆（`rm`），`read` 是幂等的。能力由工具声明（`safe` / `never`），策略由运行时统一执行——**开放-封闭**。
5. **"历史很长怎么办？"** → 现状是缺陷（无 token 预算），已在文档里列为 P1；方案是 token-aware Context Builder + 成对保留 tool call/result 的压缩摘要 + 增量搜索索引 + 按需派生。**承认现状 + 给出方案**。
6. **"为什么用 SQLite 而不是文件？"** → 需要事务（待处理输入 → 用户 entry 的转换）、需要按项目/运行查询、需要 schema 版本迁移。代价是 Main 线程阻塞风险，已登记迁 worker。

---

## 6. 建议的一句话摘要（放简历标题下）

> 独立设计并实现桌面端 AI 编程 Agent：自研 Agent 运行时（回合控制 / 分层重试 / 工具恢复账本）、可被模型编辑的本地画布（跨进程命令执行 + 乐观并发持久化）、十万级消息历史工作台；自研代码约 1.4 万行，270+ 自动化测试含真实 Electron 交互回归。
