# git/ — Git 原语

## 说明

### 职责

所有直接操作 Git 的代码都在这里：执行命令、读取仓库状态、任务检查点、提交信息、本地仓库登记、Worktree、CI 查询。界面和跨领域流程通过 `application/use-cases/` 使用这些原语。

### repository/ — 命令与仓库状态

| 文件 | 内容 |
| --- | --- |
| `command.ts` | `runGit()` / `runGitSync()` / `runGitChecked()`：统一的 Git 子进程执行、超时、失败分类 |
| `integration.ts` | 仓库检查、身份（user.name/email）、状态预览、初始化、初始基线提交、按路径提交 |
| `workspace-changes.ts` | 任务前后的工作区基线快照与变更检测、Review 状态指纹 |
| `discard-changes.ts` | 把工作区丢弃回 HEAD（先预览、再执行） |
| `failure-diagnosis.ts` | 把因具体路径导致的 Git 失败翻译成可读原因（如 Windows 保留名） |
| `bash-command-classifier.ts` | 保守判断一条 Bash 命令是否只读，用来决定是否需要先建检查点 |
| `source.ts` | `parseGitUrl()`：解析 Git 源地址 |
| `review-types.ts` | 变更与 Review 相关的类型 |

### checkpoints/ — 任务检查点

| 文件 | 内容 |
| --- | --- |
| `checkpoint.ts` | 检查点的创建、持久化（`~/.myharness/agent/checkpoints/` 元数据 + 仓库内 `refs/myharness/checkpoints/`）、完成/保留/作废、恢复、清理，以及任务期间的 HEAD 与工作区变化收集 |
| `coordinator.ts` | `AgentSessionGitCheckpointCoordinator`：在会改动文件的工具调用前按需建立检查点，并向会话发出开始/结束事件 |

### commits/

`message.ts`：根据真实 `git diff` 生成 conventional commits 风格的提交信息，不编造改动。

### local-repositories/

`store.ts`：`LocalGitRepositoryStore`（`local-git-repositories.json`）。登记、选择、初始化受管理的本地仓库；重命名和移动仓库目录的校验与事务。

### worktrees/

`manager.ts`：`GitWorktreeManager`。列出、创建、合并、删除 Worktree。

### ci/

| 文件 | 内容 |
| --- | --- |
| `types.ts` | Push 后 CI 的工作流、运行、作业、失败证据类型 |
| `github-actions.ts` | `GitHubActionsCiProvider`：发现会被 push 触发的工作流并查询运行结果 |

### 依赖

- 依赖：`utils`（子进程、路径、Shell 词法）、`src/config.ts`、`providers/credentials/account-connections.ts`（CI 查询用 GitHub 连接）。
- 被依赖：`application/use-cases`、`agent/runtime`（检查点协调器、Auto Memory 取仓库根）、`context/file-diff.ts`、`extensions/packages`、`modes/interactive`、`modes/web`。

## 维护

- 新的 Git 调用一律走 `repository/command.ts`，不要在别处自己 `spawn("git")`。
- 检查点会写仓库内的 ref 和用户目录下的元数据，属于高风险区域：改动前确认创建、恢复、失败回滚三条路径都有测试。
- 检查点与工作区检测只保存事实，不替用户决定保留还是撤销；决策流程在用例和界面里。
- 界面组件里不实现 Git 规则；需要多步流程时写成 `application/use-cases/` 的用例。
- `ci/` 只读取 CI 结果，不触发或修改工作流。
- 相关测试：`git-*.test.ts`、`bash-command-classifier.test.ts`、`workspace-changes.test.ts`、`local-git-repository-store.test.ts`、`agent-session-git-checkpoint-events.test.ts`、`phase10-worktree-architecture.test.ts`。
