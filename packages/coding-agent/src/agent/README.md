# agent/ — Agent 会话运行时

## 说明

### 职责

`agent/` 负责把底层 Agent Loop（`@myharness/agent-core`）包装成 MyHarness 的一个“会话”：谁在跑、跑到哪一步、怎么取消、怎么换会话。它不画界面，也不自己实现各业务板块的规则。

### runtime/ — 会话生命周期

| 文件 | 内容 |
| --- | --- |
| `agent-session.ts` | `AgentSession`：所有运行模式共用的会话门面。负责事件订阅与转发、prompt 准入与队列、一次任务从开始到 `agent_settled` 的收尾顺序、重试、取消与销毁，以及把会话接到扩展上。各业务板块的具体做法由对应领域的模块完成（见下方“AgentSession 委托的领域模块”） |
| `session-runtime.ts` | `AgentSessionRuntime`：当前会话及其随工作目录变化的服务；负责新建、恢复、fork、导入、切换 Workspace |
| `services.ts` | `createAgentSessionServices()`：创建随工作目录绑定的服务（Settings、ModelRuntime、ResourceLoader、Code Intelligence） |
| `sdk.ts` | `createAgentSession()`：SDK 入口，解析模型、工具、Session 并创建 `AgentSession` |
| `session-bridge.ts` | 会话桥：拥有会话写锁的进程向其他 MyHarness 进程开放该会话（回环端口上的 NDJSON 协议，地址写在 `<session>.jsonl.bridge`） |
| `mirror-agent-session.ts` | `MirrorAgentSession`：附着到另一个进程正在运行的会话，只读状态 + 把操作转发给拥有者 |
| `run-state.ts` | 对外可见的运行状态：快照 `RunStateSnapshot` 及其判断函数；`RunStateTracker` 持有当前状态、把 Agent 事件翻译成活动描述并限流通知；`terminalOutcomeFromAssistant()` 等终态推导 |
| `messages.ts` | 产品层自定义消息类型（Bash 执行、压缩摘要、分支摘要、重载摘要）和 `convertToLlm()` |
| `auto-memory.ts` | `AutoMemoryManager`：长期记忆的召回、提取、整理 |
| `conversation-title.ts` | 会话标题生成与批量重命名 |
| `assistant-model.ts` | 辅助模型（Auto Memory、Sub-agent、Vision）“跟随主模型”的解析 |
| `role.ts` | `AgentRole`（main / delegated / reviewer）、角色提示和按角色限制工具名 |
| `defaults.ts` | `DEFAULT_THINKING_LEVEL` |

### delegation/

| 文件 | 内容 |
| --- | --- |
| `event-parser.ts` | 解析子进程（Sub-agent）输出的 JSON 事件流，供 `tools/sub-agent.ts` 使用 |
| `background-work.ts` | `SessionBackgroundWork`：一个会话的主任务启动的后台工作（后台 Explore 批次、运行中的 workflow/ultracode）。登记、进度限流、主任务结束时一并取消、批次完成后把结果交回模型 |

### vision/

| 文件 | 内容 |
| --- | --- |
| `assistant.ts` | `VisionAssistantManager`：主模型不支持图片时，用视觉模型先把图片/文档页转成文字 |
| `capability.ts` | 判断与探测模型是否支持图片输入 |
| `document-corpus.ts` | 富文档（PDF、Office 等）拆页后的清单与目录约定 |

### AgentSession 委托的领域模块

`AgentSession` 不直接实现各板块规则，而是持有各领域的模块，并通过每个模块自己的 Host 接口（或构造参数）提供所需能力：

| 模块 | 所在位置 | 负责 |
| --- | --- | --- |
| `RunStateTracker` | `agent/runtime/run-state.ts` | 运行状态快照与终态 |
| `SessionBackgroundWork` | `agent/delegation/background-work.ts` | 后台 Explore 批次与 workflow 控制 |
| `AgentSessionContextCoordinator` | `context/coordinator.ts` | 上下文预算检查与自动压缩触发 |
| `SessionCompactionRunner` | `context/compact/session-compaction.ts` | 一次压缩的执行：选模型、问扩展、写检查点、重建上下文 |
| `navigateSessionTree()` | `context/compact/tree-navigation.ts` | 会话树内移动叶子与分支摘要 |
| `AgentSessionGitCheckpointCoordinator` | `git/checkpoints/coordinator.ts` | 任务检查点 |
| `AgentSessionTraceCoordinator` | `observability/session-trace.ts` | 运行追踪 |
| `collectSessionUsageStats()` | `observability/session-stats.ts` | 会话的消息数、Token 与费用统计 |
| `ProviderRecoveryCoordinator` | `providers/recovery/coordinator.ts` | Provider 故障恢复 |
| `SessionModelController` | `providers/runtime/session-model.ts` | 模型与 Thinking 档位的切换、循环、配置变更后的校正 |
| `resolveSummarizationRequestAuth()` | `providers/runtime/request-auth.ts` | 压缩与摘要请求的凭证 |
| `SessionToolRegistry` | `tools/session-tool-registry.ts` | 内置、SDK、扩展工具的装配与启用规则 |
| `SessionBashRunner` | `tools/shell/session-bash.ts` | 用户直接执行的 Bash 命令及其记录 |
| `ExtensionAgentEventForwarder` | `extensions/runtime/agent-events.ts` | 把 Agent 事件转成扩展事件 |
| `expandSkillCommand()` | `skills/invocation.ts` | `/skill:名称` 展开 |
| `collectSystemPromptOptions()` | `system-prompts/composer/index.ts` | 收集系统提示的输入 |
| `exportSessionBranchToJsonl()` | `exports/jsonl/session-export.ts` | JSONL 导出 |

留在 `AgentSession` 里的是跨这些模块的顺序和时机：什么时候算一次任务开始和结束、取消时按什么顺序停、压缩期间如何断开和恢复事件、每个操作如何计入“是否空闲”。

### 对外接口

`src/index.ts` 公开导出 `AgentSession`、`AgentSessionRuntime`、`createAgentSession*`、消息类型和 `RunStateSnapshot`。事件联合类型 `AgentSessionEvent` 是所有前端（TUI、Web、print/json、SDK）共同依赖的契约。

### 依赖

- 依赖：`@myharness/agent-core`、`@myharness/ai`，以及 `application`（`ResourceLoader`）、`config`、`context`、`extensions`、`git/checkpoints`、`observability`、`providers`、`session`、`system-prompts`、`tools`、`workflow`。
- 被依赖：`main.ts`、`modes/*`、`application/use-cases`、`extensions/runtime`、`session/*`（只用 `messages.ts`）、`context`（`messages.ts`、`role.ts`）。

## 维护

- `AgentSession` 只做流程编排。新增某个板块的状态机或规则时，放进那个板块的目录并以“模块 + Host 接口”接入，不要在 `AgentSession` 里新增大段业务代码，也不要让它直接导入板块内部的实现函数。`test/phase3-architecture.test.ts` 会检查已抽出的状态和实现没有被搬回来。
- 领域模块通过 Host 回调拿到它需要的能力（发事件、问扩展、取凭证）。Host 里需要调用会话公开方法时走 `this.方法()`，这样 `MirrorAgentSession` 的覆盖仍然生效（例如 `setThinkingLevel`）。
- `AgentSessionEvent` 的字段、事件顺序（尤其 `agent_end` → 收尾 → `agent_settled`）是前端与扩展的契约，改动前检查 `modes/interactive`、`modes/web/host.ts`、`modes/print-mode.ts` 和扩展事件。
- 测试通过名字访问了少量私有成员：`_runAutoCompaction`、`_checkCompaction`、`_trackBackgroundExploreTask`、`_emitExtensionEvent`、`_extensionRunner`。它们在 `AgentSession` 上保留为薄的转发方法；改名或删除前先看 `test/` 中的用法。
- `messages.ts` 被 `session/` 和 `context/` 使用，属于会话格式的一部分，不要引入对上层模块的依赖。
- 会话桥和镜像会话涉及跨进程写锁，修改时同时检查 `session/bridge/descriptor.ts` 和 `session-bridge.test.ts`、`session-writer-lock-owner.test.ts`。
- 相关测试：`test/agent-session-*.test.ts`、`test/suite/agent-session-*.test.ts`、`test/suite/regressions/`、`auto-memory.test.ts`、`conversation-title.test.ts`、`vision-*.test.ts`、`delegated-event-parser.test.ts`。
