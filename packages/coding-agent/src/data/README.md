# data/ — Workspace 登记与数据定位

## 说明

### 职责

管理“哪些文件夹是 Workspace、它们的 ID 是什么、数据放在哪”。Session 存储通过这里得到 Workspace ID，而不依赖界面或 `application/`。

| 文件 | 内容 |
| --- | --- |
| `workspace-store.ts` | `WorkspaceStore`：读写 `data/workspaces/registry.json` 和每个 Workspace 的 `metadata/workspace.json`；路径规范化、稳定 ID、增删、搬迁、一致性检查；`resolveWorkspaceDataContext()` / `findWorkspaceDataContext()` 把工作目录映射到 Workspace 数据目录 |
| `workspace-registry-migration.ts` | `migrateWorkspaceRegistry()`：把旧位置的 Workspace 记录迁入当前布局，带 marker 和归档 |

### 对外接口

`application/workspace-store.ts` 原样 re-export `WorkspaceStore` 等，`src/index.ts` 从那里公开导出。

### 依赖

- 依赖：`config/paths`、`src/config.ts`、`utils`（原子写、路径）。
- 被依赖：`application`、`session/manager`、`session/storage`、`session/migrations`、`modes/web`、`migrations.ts`。

## 维护

- Workspace 的身份键是规范化后的真实根目录；同一文件夹被移除后再次添加会沿用原 ID。不要让 Session 代码自己生成或改写 Workspace ID。
- 移除 Workspace 只删登记记录，不删它下面的 Session 数据。
- 列出或读取 Session 不应顺带登记 Workspace；只有显式的添加动作才写 registry。
- 写入使用原子替换；迁移必须可重入、可恢复（marker + 归档），不能在失败时丢数据。
- 数据布局变化要同步 `docs/STORAGE.md` 和架构手册的持久化表。
- 相关测试：`workspace-store.test.ts`、`workspace-registry-migration.test.ts`、`workspace-crash-recovery.test.ts`、`session-unbound.test.ts`。
