# application/ — 资源加载与跨领域用例

## 说明

### 职责

`application/` 是产品层的协调层，只做两件事：

1. 把分散在各领域的资源（Extension、Skill、Prompt Template、Theme、项目上下文文件、`SYSTEM.md`）加载成一个统一的 `ResourceLoader`；
2. 提供跨多个领域的用例（use case），让 TUI 和 Web 两个前端调用同一份流程。

它不是万能业务目录，也不是启动层：启动对象的组装在 `src/main.ts` 和 `agent/runtime/services.ts`。

### 文件

| 文件 | 内容 |
| --- | --- |
| `resource-loader.ts` | `ResourceLoader` 接口和 `DefaultResourceLoader`：加载 Extension、Skill、Prompt Template、Theme、`AGENTS.md`/`CLAUDE.md`、`SYSTEM.md`/`APPEND_SYSTEM.md`，支持 `extendResources()` 和 `reload()` |
| `project-trust.ts` | `resolveProjectTrusted()`：按运行模式（interactive / print / web）决定当前项目是否受信任，必要时询问用户 |
| `workspace-store.ts` | 只做 re-export：`WorkspaceStore` 的实现在 `data/workspace-store.ts` |
| `experimental.ts` | `areExperimentalFeaturesEnabled()` |

### use-cases/ — 跨领域用例

| 文件 | 用例 | 涉及的领域 |
| --- | --- | --- |
| `git-commit.ts` | `GitCommitUseCase`：`/commit` 的提交目标选择、提交信息生成、失败分类 | `git/checkpoints`、`git/commits`、`git/repository` |
| `git-workspace.ts` | 当前 Workspace 的 Git 操作（无状态函数）：`/commit`、`/push`、`/restore` 和任务决策前的仓库检查，仓库初始化与身份设置，首次提交，任务检查点的完成/作废/恢复，任务变更检测 | `git/checkpoints`、`git/commits`、`git/repository` |
| `local-git-repository.ts` | `LocalGitRepositoryUseCase`：本地仓库的添加、初始化、删除 `.git`、重命名、移动；移动正在使用的仓库时把会话、Workspace 记录和仓库记录一起迁移并在失败时回滚 | `git/local-repositories`、`data`（WorkspaceStore） |
| `conversation-title.ts` | 会话标题：保存标题、用模型生成标题、批量给一个 Workspace 的会话生成标题 | `agent/runtime/conversation-title.ts`、`session/manager` |
| `git-push.ts` | `GitPushUseCase`：显式 Push、remote 校验、fast-forward 判断、CI 结果验收 | `git/repository`、`git/ci` |
| `git-worktree.ts` | `GitWorktreeUseCase`：Worktree 的创建、切换、合并、删除 | `git/worktrees` |
| `provider-settings.ts` | `ProviderSettingsUseCase`：Provider 启用/禁用后同步当前模型 | `agent/runtime`、`config/settings` |
| `workspace-session.ts` | `WorkspaceSessionUseCase`：Workspace 下的 Session 列表、删除 | `session/manager`、`session/storage` |

每个用例通过自己的 `*Host` 接口或参数向前端要它需要的能力（显示状态、询问用户、切换会话目录），不直接导入任何前端代码。

`InteractiveMode` 访问 Git 只经过这些用例：它不直接导入 `git/` 下的操作函数（唯一例外是无状态的 URL 解析 `git/repository/source.ts`），也不直接调用 `SessionManager.open()` / `list()`。

### 对外接口

- `ResourceLoader` / `DefaultResourceLoader` 由 `src/index.ts` 公开导出，是 SDK 的一部分。
- 用例类只在仓库内部使用，调用方是 `modes/interactive/` 和 `modes/web/`。

### 依赖

- 依赖：`config/settings`、`config/trust`、`extensions/*`、`skills/loader`、`prompts/loader`、`themes/loader`、`system-prompts/loader`、`context`（项目上下文与角色过滤）、`data`、`git/*`、`session/*`、`agent/runtime`（仅类型和 `role.ts`）。
- 被依赖：`main.ts`、`agent/runtime`、`cli`、`modes/interactive`、`modes/web`。

## 维护

- 用例**不得导入** `modes/interactive`、`@myharness/tui` 或任何主题/组件。`test/phase3-architecture.test.ts` 会检查这一点，也会检查 `InteractiveMode` 没有重新直接导入 Git 操作。
- `git-workspace.ts` 的函数直接调用 `git/` 里的同名原语，调用次数和顺序是测试（`interactive-mode-status.test.ts` 通过 mock `git/` 模块驱动）依赖的行为；合并或调整检查步骤前先看这些测试。提示文案留在前端，这里只返回带 `kind` 的结果。
- 用例只编排，不重写底层规则：Git 命令怎么执行、Session 文件怎么写，留在 `git/`、`session/`。
- 新增跨领域流程时，先确认它确实跨了两个以上领域；只属于一个领域的逻辑放回那个领域。
- `ResourceLoader` 的 Trust 语义不能绕开：项目级 Extension、Skill、Prompt、Theme、`SYSTEM.md` 只有在项目受信任时才加载；`AGENTS.md`/`CLAUDE.md` 不受 Trust 影响。
- 修改 `ResourceLoader` 接口会影响 SDK 用户，需要同步 `docs/sdk.md`。
- 相关测试：`resource-loader.test.ts`、`phase8-resource-loader.test.ts`、`git-push.test.ts`、`git-worktrees.test.ts`、`trust-manager.test.ts`、`phase3-architecture.test.ts`、`agent-session-runtime-switch-workspace.test.ts`（仓库迁移）、`interactive-mode-status.test.ts`、`task-lifecycle.test.ts`、`workspace-interactive.test.ts`。
