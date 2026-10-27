# Agent Core 文档索引

`@myharness/agent-core` 是有状态 Agent Core：维护 Agent state、Agent event、低层 agent loop、tool lifecycle、取消、steering/follow-up 队列以及 harness/session contract。它建立在 `@myharness/ai` 的 `Models`/stream contract 上，不负责 TUI、Provider catalog 或 Node SQLite。

## 当前入口

- package exports：`packages/agent/package.json` 的 `.` 和 `./node`。
- 公共导出：`packages/agent/src/index.ts`。
- Agent 编排：`packages/agent/src/agent.ts`。
- 低层循环：`packages/agent/src/agent-loop.ts`。
- Harness/session/compaction：`packages/agent/src/harness/`。
- 按目录的源码说明与维护规则：[src/README.md](../src/README.md)。

## 现有说明

- [README](../README.md)：安装、Agent API、消息和 event flow。
- [Harness](agent-harness.md)：通用 harness contract。
- [Durable Harness](durable-harness.md)：持久化和崩溃恢复的设计笔记（尚未实现；源码里没有其中的恢复策略和队列/写入记录）。
- [Hooks](hooks.md)：`AgentHarness` hook 系统的目标设计（尚未实现；当前实现是 `AgentHarness.subscribe()`/`on()`）。
- [Models architecture](models.md)：Provider/Models 的历史目标设计；文件顶部已标明不是当前实现的完整 catalog。
- [Observability](observability.md)：观测事件的设计草案（尚未实现）。
- [CHANGELOG](../CHANGELOG.md)：历史变更记录，不能单独作为当前实现证明。

## 事实边界

当前 `Agent` 的主要调用链是 `prompt()`/`continue()` → `runAgentLoop()` → `runLoop()` → `streamAssistantResponse()`。真实 Provider 由调用方提供 `streamFunction`/`Models`；`builtinModels()` 在当前 MyHarness AI package 中不会自动提供可用模型。SQLite backend 位于独立 package，测试入口在 `packages/agent/test/harness`。

日常修改看[维护手册](maintenance.md)，跨版本或新能力看[后续开发边界](roadmap.md)。
