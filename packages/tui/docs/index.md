# TUI 文档索引

`@myharness/tui` 是终端 UI 基础库，提供 differential rendering、Component/Container/TUI、Editor、Autocomplete、Keybindings、Terminal、overlay、markdown、image 和宽度工具。

## 当前入口

- package root：`packages/tui/src/index.ts`。
- 核心运行时：`packages/tui/src/tui.ts`。
- 组件：`packages/tui/src/components/`。
- 测试：`packages/tui/test/*.test.ts`。

## 现有说明

- [TUI README](../README.md)：公共 API、内置组件和 custom component 示例。
- [维护手册](maintenance.md)：render/invalidate/focus/terminal contract、测试和 native 边界。
- [后续开发](roadmap.md)：组件、渲染和平台适配边界。
- [Coding Agent interaction guidelines](../../coding-agent/docs/interaction-guidelines.md)：产品层 Settings、导航、Action、状态和键盘行为的统一语义。

## 关键 contract

自定义 Component 实现 `render(width): string[]` 和 `invalidate()`；需要输入时实现 `handleInput()`，需要 key release 时声明 `wantsKeyRelease`。`TUI` 管理 Terminal、输入监听、focus、overlay 和差分重绘；组件不应持有 Agent、Provider 或 Session 业务状态。
