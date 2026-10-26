# Git Worktrees

MyHarness 的 `/git` 页面提供 Git Worktree 管理入口。Worktree 是同一个 Git 仓库的独立工作目录，每个目录可以对应一个开发分支；主仓库的 `main` 工作目录不会因为进入开发分支而 checkout 到其他分支。

在 Web UI 中：

1. 执行 `/git`，选择已登记的 Git 仓库，打开 Worktrees。
2. 用 Create 为已有分支创建 Worktree，或从 `main` 创建新分支及 Worktree（`POST /api/git/worktrees/create`）。
3. 用 Enter 进入。进入后，新的 Agent session 会以该 Worktree 的实际路径作为工作目录，后续文件修改不会写入其他 Worktree。
4. 用「启动副本」在当前浏览器打开新标签页：服务端用 Node 直接运行该副本自己的 `packages/coding-agent/src/web.ts` 与 `scripts/dev-fast-loader.mjs`（`--port 0`），从启动日志的实际地址 `MyHarness Web UI: <url>` 取地址，服务本身不打开浏览器。副本缺少这两个文件时拒绝启动。
5. 分支完成后可以「合回 `main`」：合并成功后副本标为已合并，作为只读记录保留。用 Combine 则是真实合并到 `main`，合并成功后才清理该分支的 Worktree 和遗留的启动文件；冲突会保留 Git 的真实冲突状态，不会自动覆盖或清理。

Web UI 的分支浮层与输入框上方的「合回 main」按钮提供一键流程（创建并进入副本、合回 main、删除时在这一行下面的一次确认），详见 [Web UI](web-ui.md) 的「Worktree 副本」一节。那里的合回不会删除副本：合并成功后副本标为已合并，作为只读记录保留。

Worktree 默认创建在 agent data 目录的 `worktrees/<repository>/<branch>/` 下，主仓库目录的启动方式保持不变。删除操作使用正常的 `git worktree remove`，如果目录有未提交修改，Git 会拒绝删除并保留原状态。

副本用完不会自动删除：子智能体或脚本留下的副本会被标记为已归档（记录在 agent data 目录的 `worktrees/archive/`），从活动列表移到「已归档副本」组，文件夹、提交和未提交改动都留在原处。读取副本列表时，已归档副本和 prunable 副本不再返回 `changes`/`ahead`（每个已归档副本原本要跑两条 Git 命令，几百个归档会拖住整个服务），它们只显示「已归档」状态；删除仍以 `git worktree remove` 的真实结果为准，脏副本会被 Git 拒绝并由界面提供强制删除确认。删除给 Git 10 分钟（Windows 上带完整 `node_modules` 的副本、或 Git 反复重试被占用的文件时会很慢），因为中途被停掉的删除会先删掉副本的 `.git` 链接文件，留下一个半删的文件夹，之后 Git 每次都以 “validation failed … .git does not exist” 拒绝；遇到这种 Git 标为 prunable、且 Git 记录正好指向该文件夹的副本，删除改为直接删完文件夹和这条记录（无法再检查改动，提交仍在共享仓库里，分支保留）。Git for Windows 遇到 junction（如 npm 放在 `node_modules` 里的工作区链接）会报告成功却留下文件夹，删除后剩下的文件夹也一并清掉，junction 只解除链接、不跟进去删。恢复、清空与强制清空的完整行为见 [Web UI](web-ui.md) 的「归档」小节。
