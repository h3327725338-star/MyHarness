# Agent Core 后续开发边界

本文件记录候选方向，不是已承诺的版本计划。

## 优先保持的 contract

- Agent lifecycle：prompt、continue、follow-up、steering、abort 和 tool execution 要有可恢复的状态边界。
- Stream contract：低层 loop 与上层 `Models.streamSimple` 的职责分开，错误必须能通过 event/stop reason 观察。
- Message conversion：应用自定义 `AgentMessage` 时沿用 `convertToLlm`，不要把 UI-only message 直接送给 LLM。
- Harness/session：持久化、compaction、branch summary 和恢复必须保持与宿主环境无关。

## 可实施方向

1. 为新增 event 或队列语义补充 Agent unit test、harness test 和恢复测试。
2. 为新的 storage backend 复用现有 session/storage contract，不把 Node SQLite 特性带入核心接口。
3. 继续完善取消和失败恢复的诊断信息，同时保持 credential 脱敏。
4. 让 observability hook 能记录时序、usage 和取消原因，但不把观测数据变成业务状态。

## 开发完成条件

- 先更新公共类型和调用方影响清单；
- 覆盖正常、取消、Provider error、tool error、重试和恢复路径；
- 相关 README/专题文档与实际源码同步；
- 明确哪些验证只是 unit/harness，哪些还未经过真实 Provider 或桌面/终端运行。
