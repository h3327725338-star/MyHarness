# packages/agent/src — Agent Core 源码目录

本文件按目录说明 `@myharness/agent-core` 的源码。包级说明见 [docs/index.md](../docs/index.md)，包级维护规则见 [docs/maintenance.md](../docs/maintenance.md)。

## 说明

### 顶层文件 — Agent 与循环

| 文件 | 内容 |
| --- | --- |
| `types.ts` | `AgentMessage`、`AgentState`、`AgentTool`、`AgentEvent`、`AgentLoopConfig`、工具调用前后钩子的上下文与返回值、`StreamFn` |
| `agent-loop.ts` | 底层循环：请求模型、流式接收、执行工具、处理 steering/follow-up 队列、停止与错误。全程使用 `AgentMessage`，只在调用模型前转换成 LLM 消息 |
| `agent.ts` | `Agent`：有状态的门面。持有 state、订阅者、队列、取消信号；`prompt()` / `continue()` / `abort()` |
| `proxy.ts` | `streamProxy()`：经由服务端转发模型请求的流函数 |
| `index.ts` | 包根出口（也原样导出 `@myharness/ai`） |
| `node.ts` | `./node` 出口：根出口 + Node 执行环境 |

### harness/ — 通用 Harness

不依赖具体产品的“会话 + 资源 + 执行环境”抽象。

| 文件 | 内容 |
| --- | --- |
| `types.ts` | Harness 的全部契约：`Result`、文件系统/Shell/执行环境接口、会话树条目、Session 存储与仓库接口、Harness 事件与选项、各类错误 |
| `agent-harness.ts` | `AgentHarness`：把 Agent 循环、Session、压缩、分支导航、Skill 与 Prompt Template 调用组合起来 |
| `messages.ts` | Harness 自定义消息类型和 `convertToLlm()` |
| `prompt-templates.ts` | Prompt Template 的加载、参数替换、调用格式 |
| `skills.ts` | Skill 的加载与调用格式 |
| `system-prompt.ts` | 系统提示中的 Skill 清单格式 |

### harness/compaction/

| 文件 | 内容 |
| --- | --- |
| `compaction.ts` | 切分点选择、用量估算、生成摘要 |
| `branch-summarization.ts` | 分支摘要 |
| `utils.ts` | 对话序列化、文件操作清单、用户锚点 |
| `codex.ts`、`codex-remote.ts` | Codex 风格的本地/远程压缩；来源与许可见同目录的 `CODEX-NOTICE.md`、`CODEX-LICENSE` |

### harness/session/

| 文件 | 内容 |
| --- | --- |
| `session.ts` | `Session`：会话树、叶子指针、从条目构建上下文 |
| `jsonl-storage.ts`、`jsonl-repo.ts` | JSONL 存储与仓库 |
| `memory-storage.ts`、`memory-repo.ts` | 内存存储与仓库 |
| `repo-utils.ts` | ID、时间戳、fork 条目选择等共用函数 |

### harness/env/

`nodejs.ts`：`NodeExecutionEnv`，基于 Node 的文件系统和 Shell 实现。只从 `./node` 出口导出。

### harness/utils/

`truncate.ts`（按行/字节截断）、`shell-output.ts`（带捕获的 Shell 执行与二进制输出清理）。

### 依赖方向

```text
index.ts → agent.ts → agent-loop.ts → types.ts
harness/agent-harness.ts → agent-loop.ts、harness/session、harness/compaction
harness/env/nodejs.ts → harness/types.ts（只有它使用 node: 内置模块做文件与进程操作）
```

对外只依赖 `@myharness/ai`。`harness/types.ts` 与 `index.ts` 之间存在类型/re-export 层面的循环引用（已知）。

## 维护

- `Agent`、`AgentEvent`、工具钩子、队列模式是被 `packages/coding-agent` 和 SDK 用户依赖的公共 API，改动要保持兼容。
- 根出口不能依赖 Node 专有模块；Node 相关实现只放 `harness/env/`，并只从 `./node` 导出。
- 这里的 `harness/session` 与 Coding Agent 产品用的 Session（`packages/coding-agent/src/session/`）是两套实现：前者是通用抽象及其 JSONL/内存后端（SQLite 后端在 `packages/storage/sqlite-node`），后者是产品的 JSONL v3。不要混用。
- 不在本包写入产品文案、Slash Command、项目路径或 Provider 目录。
- `harness/compaction/codex*.ts` 含第三方来源代码，修改时保留同目录的声明文件。
- 测试：`packages/agent/test/`（`agent.test.ts`、`agent-loop.test.ts`、`harness/*.test.ts`）。命令见 [docs/maintenance.md](../docs/maintenance.md)。
