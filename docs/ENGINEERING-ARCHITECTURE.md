# Agent Studio 工程架构与实现契约

> 版本：v0.2 · 日期：2026-08-27
> 本文从原 `docs/DESIGN.md` 中拆出工程内容；产品和视觉决策分别见 `docs/product-behavior/`、`docs/UX-DESIGN.md`、`docs/UI-DESIGN.md`。

## 1. 分层职责

```text
React Renderer
  └─ reducer / selectors / presentational components
       ↕ window.agentAPI
Preload (contextBridge)
       ↕ IPC channels
Electron Main / AgentRunner
       ↕ AgentEvents
Agent Runtime
  ├─ Model Provider adapters
  └─ Bash Operations (local / Docker)
```

| 层 | 职责 | 不负责 |
|---|---|---|
| Renderer | 收集输入、渲染状态、搜索当前 transcript、发起 run/stop | 不执行命令，不持有 Provider SDK |
| Preload | 暴露最小且类型化的 API | 不理解业务状态 |
| Main/Runner | 生命周期、AbortController、事件桥接 | 不渲染 UI，不解释模型内容 |
| Agent Runtime | query → action → result → 下一回合的编排 | 不依赖 React 或 Electron |
| Provider | 把 OpenAI/Anthropic/Google 协议归一化 | 不执行 bash，不决定 UI |
| Execution | 本机或 Docker 执行命令并返回诊断字段 | 不调用模型 |

保留 Electron `contextIsolation:true`、`sandbox:true`、`nodeIntegration:false`。

## 2. 领域契约

### 2.1 执行结果

```ts
interface ExecResult {
  output: string;
  returncode: number;
  truncated: boolean;
  fullOutputPath?: string;
}
```

`returncode`、截断状态和完整输出路径是诊断能力，任何 UX/UI 重构都不能吞掉。

### 2.2 Run snapshot

Renderer 在发送时创建不可变 `RunRequest` 快照。设置草稿与当前运行快照分离；运行中设置只读。下一次重试创建新的 `runId`，不能复用旧事件流。

### 2.3 AgentEvent 目标形态

当前事件依赖“最后一步 + actionCursor”，无法支撑流式、迟到事件或未来并行 action。目标协议必须显式携带身份：

```ts
type AgentEvent =
  | { type: "runStarted"; runId: string }
  | { type: "turnStart"; runId: string; stepId: string; stepNumber: number; messageCount: number }
  | { type: "llmDelta"; runId: string; stepId: string; text: string }
  | { type: "llmResponse"; runId: string; stepId: string; content: string; actions: Array<{ actionId: string; command: string }> }
  | { type: "actionStart"; runId: string; stepId: string; actionId: string; command: string }
  | { type: "actionDone"; runId: string; stepId: string; actionId: string; command: string; result: ExecResult }
  | { type: "done"; runId: string; status: "completed" | "step_limit" | "cancelled" | "error"; totalSteps: number; error?: RunError };
```

`RunError` 应至少包含用户可读的 `message`、稳定的 `kind`（config/network/model/command/runtime）和可选的 `retryable`，不能只写 console。

## 3. 取消与错误

- Provider query 必须接收 `AbortSignal`，命令执行继续接收同一 signal。
- stop 先让 renderer 进入 `stopping`，后端完成取消后发 `done(status:"cancelled")`。
- `done(status:"error")` 只表示系统或运行失败；用户主动停止不得复用 error。
- `run()` invoke reject 也必须由 renderer 收敛为终止状态，不能留下永久 running。
- 运行期错误沿 `runtime → runner → IPC → reducer → UI` 完整传递；错误恢复动作在 renderer 发起新的明确命令。

## 4. 流式输出

流式是 provider、runtime、IPC、reducer 的联合能力，不在组件中用定时器伪造：

1. Provider 读取增量文本和工具调用片段。
2. Runtime 发出 `llmDelta`，最终发出完整 `llmResponse`。
3. Runner 原样桥接并保留 `runId/stepId`。
4. Reducer 按身份追加文本，使用节流 selector 降低渲染频率。
5. Composer/对话流只消费 state，不直接监听 Provider。

## 5. 搜索实现边界

当前搜索是 renderer 层的派生能力：从已接收的 transcript state 构建可搜索字段，按 `runId` 隔离，支持增量更新和滚动定位。它不新增 IPC 通道、不读取磁盘、不索引 API Key。

未来引入 session store 后，搜索才迁移到持久化索引；本版本不要提前实现历史会话数据模型。

## 6. 实现顺序

1. 先统一 PM 范围与事件状态语义。
2. 升级 `runId/stepId/actionId` 和错误/取消契约。
3. 接入 provider streaming 与 AbortSignal。
4. 重构 reducer/selectors，补齐最终回答、失败命令和当前 run 搜索。
5. 按 `UX-DESIGN.md` 重排 renderer 组件树。
6. 按 `UI-DESIGN.md` 收敛 tokens、图标、视觉状态和响应式。
7. 对 IPC、reducer、provider、关键键盘流程和浏览器原型分别验证。

## 7. 安全与质量约束

- API Key 只保留在进程内存/环境变量，不写日志；文档示例统一使用 `[REDACTED_SECRET]`。
- Agent 的模型决策、runtime 授权和 execution 执行是三个责任边界，前端不直接执行工具。
- Docker 是显式执行环境，不可在 UI 中暗中切换。
- 新组件必须从单一状态源派生，避免 configOpen、running、error 等互相漂移。
- 删除死 action、恒等表达式和重复 system prompt；重构应减少状态分支，而不是增加场景字符串。
