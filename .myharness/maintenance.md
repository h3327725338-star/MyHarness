# `.myharness` 维护手册

项目级配置说明见 [README](README.md)，全局架构和路径边界见 [根维护手册](../MAINTENANCE.md)。当前 checkout 可见的项目设置以 `settings.json` 和 Coding Agent 的 Settings schema/source 为准。

## 当前边界

- 当前项目配置只记录 `gitIntegration.enabled`；不要据此推断所有全局设置或运行时状态。
- 用户级配置位于 `%USERPROFILE%\.myharness\`，不应复制进仓库文档、提交或测试 fixture。
- `data/`、Session、缓存、Trace、模型 store 和凭据属于运行时数据；它们不是项目配置，也不应为了文档审计被清理或覆盖。
- 修改设置字段前先检查 `packages/coding-agent/src/config/` 的 schema、默认值、migration 和消费者。

## 修改与验证

修改配置 schema、默认值、路径或 migration 时，必须同步相关 Settings/paths 文档和测试。静态 JSON 检查只能证明文件可解析；不能证明启动、Session 持久化、Provider 请求或 Git 集成在本机成功。

不要在配置样例或日志中写入 API Key、OAuth Token、Cookie、Session 私密内容或真实用户路径。
