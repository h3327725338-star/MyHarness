# session/ — 会话格式与持久化

## 说明

### 职责

定义一个会话在磁盘上长什么样（JSONL v3）、怎么读写、怎么从条目树还原出发给模型的历史，以及旧格式怎么迁移。Agent 怎么运行不归这里管。

### 文件与子目录

| 路径 | 内容 |
| --- | --- |
| `types.ts` | 会话文件头、全部条目类型（消息、模型切换、Thinking 切换、压缩、分支摘要、自定义条目、标签、会话信息）、树节点、`SessionInfo`、诊断类型、`CURRENT_SESSION_VERSION` |
| `manager/index.ts` | `SessionManager`：创建/打开/继续/fork/导入会话；追加条目；分支与叶子指针；写锁；未绑定会话（`isUnbound()`、`listUnbound()`、`createLike()`）；会话列表 |
| `manager/cwd.ts` | 会话记录的工作目录不存在时的检查与提示 |
| `projection/index.ts` | 从条目树到上下文：`buildSessionContext()`、`buildContextEntries()`、`getLatestCompactionEntry()`、环检测 |
| `storage/jsonl/index.ts` | JSONL 的解析与容错、文件头读取、追加与重写、会话目录与元数据、列表扫描、搬迁 |
| `storage/jsonl/file-operations.ts` | `deleteSessionFile()`，删除聊天时保留独立 memory 目录 |
| `memory/store.ts` | Data 内总层/Workspace/Conversation 记忆、归档、引用索引、迁移和恢复 |
| `migrations/index.ts` | 条目版本迁移到当前版本 |
| `migrations/storage.ts` | 旧会话目录迁入数据目录 |
| `migrations/data-framework.ts` | 会话迁入 `data/workspaces/<workspace-id>/sessions/<session-id>/` 布局 |
| `bridge/descriptor.ts` | `<session>.jsonl.bridge`：拥有写锁的进程把自己的连接地址写在这里 |

磁盘布局：`<project root>/data/workspaces/<workspace-id>/sessions/<session-id>/conversation/*.jsonl`，元数据在同一会话的 `metadata/session.json`。

### 对外接口

`src/index.ts` 导出 `session/manager/index.ts`，其中再导出类型、projection、JSONL 工具和迁移函数。扩展通过 `ReadonlySessionManager` 读取会话。

### 依赖

- 依赖：`config/paths`、`data/workspace-store.ts`（Workspace ID）、`agent/runtime/messages.ts`（自定义消息类型）、`context/compact/utils.ts`（projection 用）、`utils`（原子写、路径）。
- 被依赖：`agent/runtime`、`application/use-cases`、`context`、`exports`、`extensions`、`modes/*`、`observability`、`tools`（结果落盘）、`migrations.ts`。

## 维护

- 会话文件是用户数据。新增或修改条目类型时：改 `types.ts`、`manager`（追加）、`projection`（是否进入上下文）、必要时加 `migrations`，并同步 `docs/session-format.md`。
- 不能删除旧版本（v1/v2）的读取和迁移；坏行要容错并给出诊断，而不是让整个会话打不开。
- 只有 `SessionManager` 和 `storage/jsonl` 写会话文件。界面、工具、`AgentSession` 都通过 `SessionManager` 追加。
- 写锁保证同一会话同一时间只有一个进程写；第二个进程通过 bridge 附着（见 `agent/runtime/session-bridge.ts`）。
- 列表和读取不应登记 Workspace；Workspace ID 由 `data/` 决定。
- 产品会话存储是 JSONL；`packages/storage/sqlite-node` 是另一个包，这里不使用。
- 相关测试：`test/session-manager/`、`session-*.test.ts`、`sdk-session-manager.test.ts`、`agent-session-branching.test.ts`、`agent-session-tree-navigation.test.ts`、`phase5-session-architecture.test.ts`。
