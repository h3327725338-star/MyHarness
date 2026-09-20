# 架构重构 Phase 1：业务与 TUI 边界

Phase 1 只切断业务工具和资源加载器对展示层实现的直接依赖，不改变工具执行、结果语义、进度、错误、取消或持久化格式。

## Tool 边界

- `tools/{files,shell,github}/*.ts` 只返回执行契约、参数 schema 和结构化 `details`，不导入 TUI、`Theme`、`InteractiveMode` 或 TUI component，也不包含 `renderCall`、`renderResult` 和 `renderShell`。
- 内置工具的展示实现位于 `tools/presentation/`，由 registry 按工具名提供。
- Interactive TUI 和 HTML export 在展示边界解析该 registry；Extension 自带 renderer 仍优先使用。
- package facade 的 `create*ToolDefinition` 保留原有 renderer 形状，由 presentation adapter 组装，兼容直接使用这些 API 的调用方。

## Theme resource 边界

`themes/loader/` 只加载和返回无 UI 的 `ThemeResource` 数据，`core/resource-loader.ts` 仅通过兼容 facade 协调它；interactive theme 模块通过 `createThemeFromResource` 将资源转换为 TUI `Theme`。Theme JSON 校验、名称规则、来源路径和来源信息保持不变。

## 自动守护

`test/phase1-architecture.test.ts` 检查业务文件的禁止依赖、renderer registry、Interactive/HTML 展示接线以及 ThemeResource 到 Theme 的转换边界。后续重构不得把 TUI 依赖重新放回业务工具文件。
