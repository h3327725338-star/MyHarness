# packages/tui/src — TUI 源码目录

本文件按目录说明 `@myharness/tui` 的源码。包级说明见 [docs/index.md](../docs/index.md)，包级维护规则见 [docs/maintenance.md](../docs/maintenance.md)。

## 说明

### 顶层文件

| 分组 | 文件 | 内容 |
| --- | --- | --- |
| 运行时 | `tui.ts` | `Component` / `Container` / `TUI`：差分渲染、焦点、overlay、光标 |
| 终端 | `terminal.ts` | `Terminal` 接口与 `ProcessTerminal`（原始模式、键盘协议协商、尺寸） |
| | `stdin-buffer.ts` | 把分片到达的输入拼成完整序列 |
| | `terminal-colors.ts` | 终端背景色与明暗模式的查询结果解析 |
| | `terminal-image.ts` | 终端图片协议（Kitty、iTerm2）、图片尺寸读取、超链接 |
| 键盘 | `keys.ts` | 按键解析与匹配（传统序列和 Kitty 键盘协议） |
| | `keybindings.ts` | 快捷键定义、`KeybindingsManager`、冲突检测 |
| | `native-modifiers.ts` | 通过原生模块读取修饰键状态（`packages/tui/native/` 下有预编译文件） |
| 编辑辅助 | `autocomplete.ts`、`fuzzy.ts`、`word-navigation.ts`、`kill-ring.ts`、`undo-stack.ts`、`editor-component.ts` | 自动补全、模糊匹配与排序、按词移动、kill/yank、撤销栈、可替换编辑器的接口 |
| 文本 | `utils.ts` | 可见宽度、ANSI 感知的换行与截断、按列切片 |
| 设计 | `design-tokens.ts` | 共用的符号与间距 |
| 出口 | `index.ts` | 包根出口 |

### components/

可复用组件：`editor.ts`（多行编辑器）、`input.ts`（单行输入）、`markdown.ts`、`select-list.ts`、`settings-list.ts`、`box.ts`、`text.ts`、`truncated-text.ts`、`spacer.ts`、`loader.ts`、`cancellable-loader.ts`、`image.ts`。

### 依赖方向

```text
index.ts → tui.ts、components/*、其余顶层文件
components/* → tui.ts、utils.ts、keys.ts、keybindings.ts、autocomplete.ts 等顶层文件
```

外部依赖只有 `marked` 和 `get-east-asian-width`。本包不依赖仓库里的其他包。

## 维护

- 组件契约：`render(width)` 返回的每一行不能超过给定宽度（按可见宽度计算，含 ANSI 和东亚宽字符）；状态变化后调用 `invalidate()`。
- 组件不持有 Agent、Provider、Session 等业务状态；产品界面在 `packages/coding-agent/src/modes/interactive/`。
- 颜色由产品层的主题提供，本包只保留符号和间距这类与语义无关的常量。
- 没有原生模块时必须有回退（`native-modifiers.ts`）。
- 键盘协议、图片协议、差分渲染各有专门测试；真实终端表现需要实际运行。
- 测试：`packages/tui/test/`（Node 内置测试运行器）。
