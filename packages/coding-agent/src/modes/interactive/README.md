# modes/interactive/ — 终端交互界面

## 说明

### 职责

MyHarness 的终端产品界面：输入框、对话区、状态栏、各种选择器和侧栏。它把用户操作交给 `AgentSession` 和 `application/use-cases/`，把 `AgentSessionEvent` 画出来。可复用的终端基础组件（编辑器、列表、Markdown 渲染等）在 `packages/tui`，不在这里。

### 顶层文件

| 文件 | 内容 |
| --- | --- |
| `interactive-mode.ts` | `InteractiveMode`：界面总装与事件循环。包括启动、输入提交与内置 Slash Command 分发、事件渲染、扩展 UI 上下文、任务结束后的收尾流程、Git 提交/Push 任务的进度与结果展示、各选择器和侧栏的打开 |
| `task-lifecycle.ts` | 从会话状态和界面流程状态推导“当前任务处于哪个阶段”（与 `AgentSession.isStreaming` 是两回事） |
| `keybindings.ts` | 应用级快捷键定义、`KeybindingsManager`、旧配置迁移 |
| `footer-data-provider.ts` | 页脚数据：Git 分支与状态监听、扩展状态文本 |
| `model-search.ts` | 模型搜索用的名称 |
| `status-format.ts` | 时长与“最近活动”的统一格式 |

### components/

每个文件一个组件。大致分组：

| 分组 | 组件 |
| --- | --- |
| 对话内容 | `assistant-message`、`user-message`、`tool-execution`（含读/搜索分组）、`bash-execution`、`custom-message`、`custom-entry`、`compaction-summary-message`、`branch-summary-message`、`reload-summary-message`、`skill-invocation-message`、`vision-assistant-message`、`diff` |
| 状态 | `status-indicator`（工作中、重试、压缩、Git、重载等）、`task-status-bar`、`footer`、`animated-thinking-label`、`countdown-timer`、`bordered-loader` |
| 输入 | `custom-editor`、`extension-editor`、`extension-input`、`extension-selector`、`keybinding-hints` |
| 选择器 | `model-selector`、`session-selector`（及 `session-selector-search`）、`settings-selector`、`theme-selector`、`thinking-selector`、`show-images-selector`、`config-selector`、`first-time-setup` |
| 设置子页 | `custom-provider-submenu`、`web-search-settings` |
| 侧栏 | `workspace-sidebar`、`local-git-repository-sidebar`、`git-worktree-sidebar` |
| 小工具 | `dynamic-border`、`visual-truncate` |

`components/index.ts` 是向 SDK 和扩展公开的组件出口。

### theme/

| 文件 | 内容 |
| --- | --- |
| `theme.ts` | `Theme` 类、全局当前主题 `theme`、内置主题加载、终端背景检测、主题文件监听、给 `@myharness/tui` 组件用的主题适配 |
| `theme-controller.ts` | `InteractiveThemeController`：按设置应用主题、自动跟随终端明暗 |
| `dark.json`、`light.json`、`theme-schema.json` | 内置主题与 schema（构建时复制） |

### assets/

界面用到的图片（构建时复制）。

### 对外接口

`src/index.ts` 导出 `InteractiveMode`、`components/index.ts`、`footer-data-provider.ts`、`theme/theme.ts`。

### 依赖

- 依赖：`@myharness/tui`、`agent/runtime`、`application`（用例、WorkspaceStore）、`cli`（命令表、设置菜单）、`config`、`extensions`（类型与 runner）、`providers/*`（余额轮询、模型匹配、使用频率排序）、`session`（类型、只读的条目投影、缺失工作目录的提示）、`tools/presentation`、`observability`、`utils`。
- Git 只经过 `application/use-cases/`（`git-workspace.ts`、`git-commit.ts`、`git-push.ts`、`git-worktree.ts`、`local-git-repository.ts`）；`interactive-mode.ts` 唯一直接导入的 `git/` 文件是无状态的 URL 解析 `git/repository/source.ts`。个别组件（侧栏）仍导入 `git/` 的类型。
- 被依赖：`main.ts`、`cli`（启动阶段复用选择器和主题）、`extensions/runtime`（类型）、`exports/html`（主题颜色）、`tools/presentation`（主题与少量组件）。

## 维护

- 组件只渲染和处理输入。不要在组件里实现 Git、Session、Provider 的规则；多步流程写成 `application/use-cases/` 的用例，`InteractiveMode` 只提供进度显示和结果处理。
- `InteractiveMode` 不直接导入 `git/` 下的操作函数，也不直接调用 `SessionManager.open()` / `list()`；需要新的 Git 或 Session 能力时在用例里加函数。`test/phase3-architecture.test.ts` 会检查。
- 交互与视觉遵循 `docs/interaction-guidelines.md` 和 `docs/tui-design-system.md`；用户文档是 `docs/tui.md`、`docs/keybindings.md`、`docs/themes.md`。
- 内置 Slash Command 和 `/settings` 菜单的定义在 `cli/`，这里只负责分发和绘制。
- 很多测试通过 `InteractiveMode.prototype.<方法>.call(假对象)` 直接调用私有方法，并依赖方法名和它访问的字段名（例如 `maybeStartCompletionWorkflow`、`settleFailedTaskGitCheckpoint`、`handleCommitCommand`、`renameSessionWithAi`、`workspaceStore`、`localGitRepositoryStore`、`localGitRepositoryUseCase`）。重命名私有成员前先搜索 `test/`。
- `theme.ts` 的全局主题是进程级状态，被 `tools/presentation` 和导出功能读取；改初始化顺序时注意这些调用方。
- 真实终端行为（输入法、Windows 终端、tmux）不能靠单元测试证明，需要实际运行。
- 相关测试：`interactive-mode-*.test.ts`、`task-lifecycle.test.ts`、`task-status-bar.test.ts`、`status-indicator.test.ts`、`footer-*.test.ts`、`settings-selector-*.test.ts`、`session-selector-*.test.ts`、`workspace-*.test.ts`、`local-git-repository-sidebar.test.ts`、`keybindings-migration.test.ts`、`theme-*.test.ts`、`tool-execution-*.test.ts`、`transcript-visibility.test.ts`。
