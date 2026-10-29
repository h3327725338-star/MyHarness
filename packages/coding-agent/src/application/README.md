# application/ — 资源加载与跨领域用例

## 说明

### 职责

`application/` 是产品层的协调层，只做两件事：

1. 把分散在各领域的资源（Extension、Skill、Prompt Template、Theme、项目上下文文件、`SYSTEM.md`）加载成一个统一的 `ResourceLoader`；
2. 提供跨多个领域的用例（use case），让 Web 前端调用统一流程。

它不是万能业务目录，也不是启动层：启动对象的组装在 `src/main.ts` 和 `agent/runtime/services.ts`。

### 文件

| 文件 | 内容 |
| --- | --- |
| `resource-loader.ts` | `ResourceLoader` 接口和 `DefaultResourceLoader`：加载 Extension、Skill、Prompt Template、Theme、`AGENTS.md`/`CLAUDE.md`、`SYSTEM.md`/`APPEND_SYSTEM.md`，支持 `extendResources()` 和 `reload()` |
| `project-trust.ts` | `resolveProjectTrusted()`：决定当前项目是否受信任（`AppMode` 当前只有 `web`），必要时经扩展事件或浏览器询问用户 |
| `workspace-store.ts` | 只做 re-export：`WorkspaceStore` 的实现在 `data/workspace-store.ts` |

### use-cases/ — 跨领域用例

| 文件 | 用例 | 涉及的领域 |
| --- | --- | --- |
| `git-commit.ts` | `GitCommitUseCase`：`/commit` 的提交目标选择、提交信息生成、失败分类 | `git/checkpoints`、`git/commits`、`git/repository` |
| `git-workspace.ts` | `inspectCommitTargetAsync()`：提交前的仓库状态与检查点归属检查（异步，不阻塞事件循环） | `git/checkpoints`、`git/repository` |
| `git-push.ts` | `GitPushUseCase`：显式 Push（推送检查过的那个 commit SHA，而不是 Push 时的 HEAD）、remote 校验、fast-forward 判断、Push 前的提示词检查钩子；`waitForCi: false` 时远端收到即返回，CI 由 `watchCi()` 另行按远端分支名查询 | `git/repository`、`git/ci` |
| `git-worktree.ts` | `GitWorktreeUseCase`：Worktree 的创建、切换、合并、删除 | `git/worktrees` |
| `provider-settings.ts` | `ProviderSettingsUseCase`：Provider 启用/禁用后同步当前模型 | `agent/runtime`、`config/settings` |
| `nebius-setup.ts` | `NebiusSetupUseCase`：用一个 Token Factory Key 配好 Nebius——读取账户模型列表核对 Key、写入 `models.json`、保存 Key、给还没有自己模型的工作配 Nemotron 模型（主模型只在没有可用主模型时设置） | `providers/models`、`providers/credentials`、`config/settings`、`agent/runtime` |
| `workspace-session.ts` | `WorkspaceSessionUseCase`：Workspace 下的 Session 列表、删除 | `session/manager`、`session/storage` |

每个用例通过自己的 `*Host` 接口或参数向前端要它需要的能力（显示状态、询问用户、切换会话目录），不直接导入任何前端代码。

Web 的变更类 Git 操作只经过这些用例（commit / push / worktree）：路由不直接复制 `git/` 规则。`WebHost` 为展示和收尾可直接读 `git/checkpoints` 与工作区变更检测、以及经 `AgentSessionRuntime` 调用 `SessionManager.open()` / `listAll()`（见 `modes/web/hub.ts`、`routes-sessions.ts`）。

### 对外接口

- `ResourceLoader` / `DefaultResourceLoader` 由 `src/index.ts` 公开导出，是 SDK 的一部分。
- 用例类只在仓库内部使用，调用方是 `modes/web/`（路由）与 `main.ts` 装配的 runtime。

### 依赖

- 依赖：`config/settings`、`config/trust`、`extensions/*`、`skills/loader`、`prompts/loader`、`themes/loader`、`system-prompts/loader`、`context`（项目上下文与角色过滤）、`data`、`git/*`、`session/*`、`agent/runtime`（仅类型和 `role.ts`）。
- 被依赖：`main.ts`、`agent/runtime`（`ResourceLoader` 类型与 `services.ts`/`sdk.ts` 创建）、`modes/web`。

## 维护

- 用例**不得导入** `modes/*` 或任何前端代码。`test/phase3-architecture.test.ts` 会检查这一点。
- `git-workspace.ts` 的函数直接调用 `git/` 里的同名原语；合并或调整检查步骤前先看 `task-lifecycle.test.ts` 与 worktree 相关测试。提示文案留在前端，这里只返回带 `kind` 的结果。
- 用例只编排，不重写底层规则：Git 命令怎么执行、Session 文件怎么写，留在 `git/`、`session/`。
- 新增跨领域流程时，先确认它确实跨了两个以上领域；只属于一个领域的逻辑放回那个领域。
- `ResourceLoader` 的 Trust 语义不能绕开：项目级 Extension、Skill、Prompt、Theme、`SYSTEM.md` 只有在项目受信任时才加载；`AGENTS.md`/`CLAUDE.md` 不受 Trust 影响。
- 修改 `ResourceLoader` 接口会影响 SDK 用户，需要同步 `docs/sdk.md`。
- 相关测试：`resource-loader.test.ts`、`phase8-resource-loader.test.ts`、`git-push.test.ts`、`git-worktrees.test.ts`、`trust-manager.test.ts`、`phase3-architecture.test.ts`、`agent-session-runtime-switch-workspace.test.ts`（仓库迁移）、`task-lifecycle.test.ts`。
