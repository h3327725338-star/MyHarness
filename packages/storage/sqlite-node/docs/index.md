# SQLite Node 文档索引

`@myharness/agent-sqlite-node` 是独立的 Node SQLite session backend。它提供 `node:sqlite` 的 `DatabaseSync` adapter、migration、`SqliteSessionRepo`、`SqliteSessionStorage` 和 materialized state。

## 当前入口

- package root：`packages/storage/sqlite-node/src/index.ts`。
- SQLite contract：`src/sqlite/types.ts`。
- migration：`src/sqlite/migrations.ts` 和 `src/sqlite/migrations/001_initial.sql`。
- repo：`src/sqlite/repo.ts`。
- storage：`src/sqlite/storage/`。
- 按目录的源码说明与维护规则：[src/README.md](../src/README.md)。
- package build：`tsgo` 后由 `scripts/prepare-dist.mjs` 复制 migration SQL。

## 重要边界

- Agent Core 不直接依赖 Node SQLite；backend 通过 `SqliteDatabaseFactory` 和 `FileSystem` capability 连接。
- 当前 migration loader 只加载 `001_initial.sql`，但 migration 表和 applied timestamp 机制已经存在。
- 本包没有自己的 `test` script；主要测试在 `packages/agent/test/harness/sqlite-migrations.test.ts` 和 `sqlite-node.test.ts`。

日常修改看[维护手册](maintenance.md)，schema/新 backend 方向看[后续开发](roadmap.md)。
