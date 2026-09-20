# SQLite Node 后续开发边界

## Migration 演进

为新字段/索引增加递增 migration，并覆盖旧数据库升级、重复执行、失败 rollback 和新进程重开。若需要回填 materialized state，必须定义幂等行为。

## Storage contract

继续让 repo/storage 通过 `SqliteDatabase`、`SqliteSessionRepoEnv` 和 Agent Core session 类型解耦。新增 backend 时复用 contract，不复制 `DatabaseSync` 细节。

## 产品接入

先确认 Coding Agent 是否真的切换到 SQLite backend，再编写“默认使用 SQLite”的说明；当前源码审计只能确认 backend 和 harness 测试存在，不能确认产品默认选用它。

## 验收条件

- migration、repo、storage 和 harness 测试同时更新；
- create/open/list/fork/delete、branch/leaf、分页和 materialized view 有真实测试结果；
- 明确 Node 版本、`node:sqlite` 可用性和其他平台限制。
