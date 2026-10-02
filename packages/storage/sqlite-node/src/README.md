# packages/storage/sqlite-node/src — SQLite 存储源码目录

本文件按目录说明 `@myharness/agent-sqlite-node` 的源码。包级说明见 [docs/index.md](../docs/index.md)，包级维护规则见 [docs/maintenance.md](../docs/maintenance.md)。

## 说明

### 顶层

`index.ts`：把 Node 的 `node:sqlite`（`DatabaseSync`）包装成本包的 `SqliteDatabase` 接口（`wrapNodeSqliteDatabase()`、`createNodeSqliteFactory()`），并导出 `sqlite/` 的全部内容。

### sqlite/

| 文件 | 内容 |
| --- | --- |
| `types.ts` | 与具体驱动无关的数据库接口（`SqliteDatabase`、`SqliteStatement`、工厂）、会话元数据、仓库选项 |
| `migrations.ts` | 读取并按顺序应用迁移，记录到迁移表 |
| `migrations/001_initial.sql` | 初始 schema（构建时由 `scripts/prepare-dist.mjs` 复制到 `dist`） |
| `repo.ts` | `SqliteSessionRepo`：会话的创建、列出、打开、删除、fork |
| `index.ts` | 出口 |

### sqlite/storage/

| 文件 | 内容 |
| --- | --- |
| `index.ts` | `SqliteSessionStorage`：实现 Agent Core 的 Session 存储接口 |
| `session-entries.ts` | 会话树条目的校验、编码、解码 |
| `session-materialized.ts` | 物化状态：当前模型与 Thinking、统计、摘要，随条目写入增量更新 |
| `branch-entries.ts` | 取当前分支路径（到最近一次压缩为止） |
| `session-sequences.ts` | 条目序号 |
| `sessions.ts` | 会话行与元数据转换 |
| `shared.ts` | ID 生成、类型判断、错误构造 |

### 依赖方向

```text
index.ts → sqlite/* → sqlite/storage/*
```

依赖 `@myharness/agent-core`（Session 契约）和 `@myharness/ai`（类型）。只有顶层 `index.ts` 使用 `node:sqlite`。

## 维护

- `packages/coding-agent` 的产品会话存储是 JSONL，不使用本包；本包是 Agent Core 通用 Session 抽象的一个后端。
- 不改已发布的迁移 SQL；schema 变化通过新增迁移文件并在 `migrations.ts` 中按顺序加载。
- `node:sqlite` 的类型不要泄漏到 `sqlite/types.ts` 之外。
- 改条目编码或物化状态时，同时检查分支、叶子、序号、重新打开、分页和 fork。
- 本包没有自己的 `test` 脚本；测试在 `packages/agent/test/harness/sqlite-node.test.ts` 和 `sqlite-migrations.test.ts`。
