# cli/ — 命令行输入与共享命令表

## 说明

### 职责

把命令行参数和启动阶段的输入变成 `main.ts` 能用的结构，并保存 TUI 与 Web 共用的两张表：内置 Slash Command 和 `/settings` 菜单。

| 文件 | 内容 |
| --- | --- |
| `args.ts` | `parseArgs()`：全部 CLI 参数的解析，`Args`、`Mode` 类型 |
| `help.ts` | `--help` 的内容；`cli-help.test.ts` 保证列出的参数都能被 `parseArgs` 接受 |
| `slash-commands.ts` | 内置 Slash Command 的**唯一注册表**（名称、别名、说明、`surfaces`: cli / web），以及命令解析和内置 prompt 命令的展开 |
| `settings-menu.ts` | `/settings` 菜单的**唯一定义**（行、顺序、名称、说明、固定选项、`surfaces`） |
| `file-processor.ts` | 处理 `@file` 参数：文本、图片、富文档 |
| `initial-message.ts` | 合并命令行文本、stdin 和 `@file` 成为第一条消息 |
| `list-models.ts` | `--list-models` 输出 |
| `project-trust.ts` | 为启动阶段创建 Project Trust 上下文（把询问交给扩展或启动 UI） |
| `session-picker.ts` | `--resume` 的会话选择界面 |
| `config-selector.ts` | `myharness config` 的资源开关界面 |
| `startup-ui.ts` | 启动阶段的小型 TUI：首次设置、选择框、输入框 |

### 对外接口

- `src/index.ts` 导出 `parseArgs`、`Args` 和 Slash Command 相关类型。
- `slash-commands.ts` 被 `AgentSession`、`modes/interactive`、`modes/web`、`extensions/compat` 使用。
- `settings-menu.ts` 被 TUI 的 `settings-selector.ts` 和 Web 的 `routes-settings.ts` 使用。

### 依赖

- 依赖：`config`、`context/context-window.ts`、`providers/runtime`、`application`（Trust、实验开关）、`modes/interactive` 的几个组件（选择器、首次设置）、`agent/vision/document-corpus.ts`、`utils/file-preprocess.ts`。
- 被依赖：`main.ts`、`agent/runtime`、`extensions`、`modes/*`、`providers/runtime`（`Args` 类型）。

## 维护

- 新增 CLI 参数：改 `args.ts` 和 `help.ts`，同步 `docs/usage.md`。
- 新增内置 Slash Command：只在 `slash-commands.ts` 登记一次；TUI 的分发在 `modes/interactive`，Web 的执行方式表在 `web/js/builtin-commands.js`。不要在某个页面里单独写命令分支。
- 新增 `/settings` 行：只改 `settings-menu.ts`；TUI 和 Web 各自只负责“怎么画、怎么打开”。
- 本目录解析和展示，不实现模型请求、Session 持久化或 Git 规则。
- 相关测试：`args.test.ts`、`cli-help.test.ts`、`slash-commands.test.ts`、`initial-message.test.ts`、`first-time-setup*.test.ts`。
