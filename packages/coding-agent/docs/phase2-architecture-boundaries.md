# 架构重构 Phase 2：Extension contracts 与兼容入口

Phase 2 将 Extension 的共享契约和旧 API 兼容逻辑分开，同时切断加载器对 `src/index.ts` 的反向运行时依赖。

## Contracts

- `src/extensions/contracts/` 只包含执行工具契约、事件路由端口、UI 原语端口和注册记录。
- `ToolDefinition` 的执行契约不包含 renderer、TUI、Theme 或具体 Session 实现。
- TUI renderer context 仍属于 `tools/presentation/`；旧的富 `ToolDefinition` 形状由兼容类型保留。

## Compat 与 API Entry

- `src/extensions/compat/` 保留旧的 Extension 类型、loader、runner 和 tool wrapper 入口，避免破坏现有 npm/第三方 Extension。
- `src/extensions/api-entry.ts` 是加载 Extension 时使用的运行时入口，提供扩展常用的工具、UI 和辅助函数，但不导入公共 `src/index.ts`。
- `src/index.ts` 只作为 npm Public Facade；内部模块直接依赖 contracts、loader、runner 或 wrapper 的具体模块。
- 历史 `core/extensions/index.ts` 仍保留为兼容 re-export。

## 自动守护

`test/phase2-architecture.test.ts` 检查 contracts 的轻量边界、loader 到 API Entry 的接线、旧包名别名，以及 Tools 不再通过 Extension public barrel 获取 ToolDefinition。
