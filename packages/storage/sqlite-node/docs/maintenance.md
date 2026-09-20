# SQLite Node 维护手册

## 调用链

`SqliteSessionRepo.openDatabase()` → 创建目录 → `node:sqlite` adapter → WAL/FULL/busy timeout 配置 → `applyMigrations()` → `SqliteSessionStorage.create/open`。

Repo 负责 create/list/open/delete/fork；storage 负责 session tree entry、active branch/leaf、sequence 和 materialized state；adapter 只负责 `SqliteDatabase`/statement/transaction 的 Node 实现。

## Schema 和 migration

- 新 schema 不要直接覆盖已发布 SQL；新增 migration 并在 migration loader 中按顺序加载。
- 每个 migration 必须在 transaction 中执行并写入 migrations 表；失败时不留下半个 schema。
- session entry payload 仍需通过类型校验；message、thinking/model/tool、compaction、branch summary、custom、label、session info 和 leaf 类型不能任意扩张。
- 修改 materialized state 时同时检查 branch、leaf、sequence、reopen、pagination 和 fork。

## 验证

```powershell
npm.cmd --workspace packages/agent run test:harness
npm.cmd --workspace packages/agent run test -- sqlite-migrations.test.ts sqlite-node.test.ts
npm.cmd --workspace packages/storage/sqlite-node run build
```

第二条命令是否被 Vitest 正确筛选取决于当前 script/runner；需要以实际输出为准。不能仅凭 build 宣称 SQLite runtime 已验证。

## 安全和兼容性

- 只保存 session 数据和 schema 所需 metadata，不保存 credential。
- 保留 close、rollback、失败后清理和目录权限语义。
- Node `DatabaseSync` 是 adapter 细节；上层依赖 `sqlite/types.ts`，不要把 `node:sqlite` 类型泄漏为通用 Agent API。
