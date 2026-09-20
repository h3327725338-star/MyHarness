# Git Worktrees

MyHarness 的 `/git` 页面提供 Git Worktree 管理入口。Worktree 是同一个 Git 仓库的独立工作目录，每个目录可以对应一个开发分支；主仓库的 `main` 工作目录不会因为进入开发分支而 checkout 到其他分支。

在交互模式中：

1. 执行 `/git`，选择已登记的 Git 仓库。
2. 按 `W` 打开该仓库的 Worktree 列表。
3. 使用 `A` 为已有分支创建 Worktree，或使用 `N` 从 `main` 创建新分支及 Worktree。
4. 选择 Worktree 后按 `Enter` 进入。进入后，新的 Agent session 会以该 Worktree 的实际路径作为工作目录，后续文件修改不会写入其他 Worktree。
5. 使用 `L` 按用户需要生成该分支的 Windows `.cmd` 启动文件。启动文件集中保存在 agent data 目录的 `worktrees/launchers/` 下，并调用对应 Worktree 中的 `dev.cmd`。
6. 分支完成后按 `C`，确认后将指定分支真实合并到 `main`。合并成功才会清理该分支的 Worktree 和专用启动文件；冲突会保留 Git 的真实冲突状态，不会自动覆盖或清理。

Worktree 默认创建在 agent data 目录的 `worktrees/<repository>/<branch>/` 下，主仓库目录和现有根目录 `dev.cmd` 的启动语义保持不变。删除操作使用正常的 `git worktree remove`，如果目录有未提交修改，Git 会拒绝删除并保留原状态。
