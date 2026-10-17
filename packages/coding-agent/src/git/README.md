# git/ — Git 原语

## 说明

### 职责

所有直接操作 Git 的代码都在这里：执行命令、读取仓库状态、任务检查点、提交信息、本地仓库登记、Worktree、CI 查询。界面和跨领域流程通过 `application/use-cases/` 使用这些原语。

### repository/ — 命令与仓库状态

| 文件 | 内容 |
| --- | --- |
| `command.ts` | `runGit()` / `runGitSync()` / `runGitChecked()`：统一的 Git 子进程执行、超时、失败分类 |
| `integration.ts` | 仓库检查、身份（user.name/email）、状态预览、初始化、初始基线提交、按路径提交 |
| `branches.ts` | 本地分支：列出、切换（`git switch`）、新建并切换（`git switch -c`）、安全删除（`git branch -d`，调用方可显式要求强删 `-D`），全部异步 |
| `workspace-changes.ts` | 任务前后的工作区基线快照与变更检测、Review 状态指纹（Final ChangeSet 全异步：worktree/head/refs/pending/index 均走 async Git，pending 用 fresh 读） |
| `discard-changes.ts` | 把工作区丢弃回 HEAD（先预览、再执行；同步与异步各一套，恢复决策始终读最新状态） |
| `status-cache.ts` | `git status --porcelain=v1 -z` 短 TTL（1s）缓存 + 并发去重；失败不入缓存、不抛错（`{ error }` 返回）。写入后由提交/丢弃/恢复调用 `invalidateGitStatusCache()` 失效；关键写操作前的读取用 `fresh: true` |
| `read-cache.ts` | 高频轮询的只读查询短 TTL + 同 key 在途合并：版本检测进程复用（5 分钟）、仓库检查（2 秒）、身份（10 秒）、状态预览（1 秒）、HEAD（2 秒）、Git 目录布局（60 秒）。失败不缓存、旧请求不覆盖新结果，`fresh: true` 强制重验，写操作后调 `invalidateGitReadCache()` 失效；提交/恢复决策仍走 `integration.ts` 直读，不改变写语义 |
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

| 文件 | 内容 |
| --- | --- |
| `message.ts` | 根据真实 `git diff` 生成 conventional commits 风格的提交信息，不编造改动 |
| `ai-message.ts` | 大 diff 的分批概括与跨文件核对：按 token 预算切分、分组摘要再合并，引用必须可回溯到 diff 片段；只产出标题与正文，不写作者归因 |

### local-repositories/

`store.ts`：`LocalGitRepositoryStore`（`local-git-repositories.json`）。登记、选择、初始化受管理的本地仓库；重命名和移动仓库目录的校验与事务。

### worktrees/

| 文件 | 内容 |
| --- | --- |
| `manager.ts` | `GitWorktreeManager`。列出、创建、合并、删除 Worktree。`readActivityAsync()` 只读地统计副本的未提交文件数和 main 没有的提交数；`mergeBack()` 把副本分支合并进 main 但保留副本：main 有未提交改动时拒绝，副本有未提交改动时需调用方明确同意先提交，冲突时执行 `git merge --abort` 并返回冲突文件，不留下合并中的状态，可按用户选择用 `-X ours/theirs` 重试。`remove()` 默认安全删除，调用方可以显式传 `force: true` 使用 `git worktree remove --force` 丢弃未提交内容；两种删除都只删除副本、保留分支，不跳过主副本保护。同步失败优先保留 Git 的 `stderr` 真正原因供界面解释。分支是否被副本占用仍由 Git 拒绝，分支 `-D` 也不能绕过，副本与分支须分别操作。 |
| `display-name.ts` | `WorktreeDisplayNames`：worktree 展示别名（`agentDir/worktrees/names/`），纯展示元数据，不改分支、目录或 Git 身份 |
| `merged-records.ts` | `WorktreeMergedRecords`：已合回 main 的副本记录（`agentDir/worktrees/merged/`），合并后副本作为只读留档；`isWorktreeCopyPath()` 只按路径判断目录是否在某个副本内（无 Git 调用、无文件访问），供侧栏区分主副本/副本空间 |
| `index.ts` | worktrees/ 出口（转出 `manager.ts`） |

### ci/

| 文件 | 内容 |
| --- | --- |
| `types.ts` | Push 后 CI 的工作流、运行、作业、失败证据类型 |
| `github-actions.ts` | `GitHubActionsCiProvider`：发现会被 push 触发的工作流并查询运行结果 |

### 依赖

- 依赖：`utils`（子进程、路径、Shell 词法）、`src/config.ts`、`providers/credentials/account-connections.ts`（CI 查询用 GitHub 连接）。
- 被依赖：`application/use-cases`、`agent/runtime`（检查点协调器、Auto Memory 取仓库根）、`context/file-diff.ts`、`extensions/packages`、`modes/web`。

## 维护

- 新的 Git 调用一律走 `repository/command.ts`，不要在别处自己 `spawn("git")`。
- 检查点会写仓库内的 ref 和用户目录下的元数据，属于高风险区域：改动前确认创建、恢复、失败回滚三条路径都有测试。
- 检查点与工作区检测只保存事实，不替用户决定保留还是撤销；决策流程在用例和界面里。
- 界面组件里不实现 Git 规则；需要多步流程时写成 `application/use-cases/` 的用例。
- `ci/` 只读取 CI 结果，不触发或修改工作流。
- 相关测试：`git-*.test.ts`、`bash-command-classifier.test.ts`、`workspace-changes.test.ts`、`local-git-repository-store.test.ts`、`agent-session-git-checkpoint-events.test.ts`、`phase10-worktree-architecture.test.ts`。
