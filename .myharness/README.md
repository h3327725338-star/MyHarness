# 项目级 `.myharness` 配置

维护规则见 [maintenance.md](maintenance.md)，后续开发边界见 [roadmap.md](roadmap.md)。字段和默认值以 Coding Agent Settings 源码为准。

`.myharness/` 保存当前项目范围的配置和 project-local 资源。它不是全局 Agent 目录，也不是 credential vault。

当前受 Git 跟踪的项目设置是 [`settings.json`](settings.json)，只启用 Git integration：

```json
{
  "gitIntegration": {
    "enabled": true
  }
}
```

## 边界

- Project settings 会覆盖 global settings；Project Trust 决定是否加载 project-local settings、extensions、skills、prompts 和 themes。
- API keys、OAuth credentials、models store 和 sessions 不应写入这里；具体路径以 `packages/coding-agent/src/config/paths` 和对应 credential/session 实现为准。
- 根 `.gitignore` 忽略 `/data/`。`data/` 是运行时 workspace/session 数据，不要把真实 session、cache 或 trace 加入文档或提交。
- 新增配置项时必须同步 Settings schema、默认值、UI/CLI 入口、测试和 [Coding Agent 设置文档](../packages/coding-agent/docs/settings.md)。

## 修改后核对

修改项目配置后，检查 JSON、Project Trust、全局覆盖关系和真实启动路径。只读静态检查不能证明配置已经在新的进程或外部 Provider 请求中生效。
