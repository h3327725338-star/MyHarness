# Git 写操作与 Commit / Push 规范

本文是 MyHarness 仓库自身 Git 写操作的权威规范。普通源码阅读和只读 Git 查询不要求
读取本文；准备改变 index、历史、ref 或远端状态时，必须先读完本文。本文适用于 Coding
Agent、Harness、IDE Agent、自动化脚本和人工维护者。

## 工作区不等于项目文件

文件位于仓库目录中、出现在 `git status` 中或已经被跟踪，都不代表它属于 MyHarness
正式源码。stage 前必须确认新增内容的来源、用途和项目归属。只提交正式源码、配置、测试、
项目文档和明确需要版本控制的资产。

由 Agent、Harness、IDE 或自动化开发工具生成的本地工作目录、状态、缓存、会话、记忆、scratch 和报告默认不属于正式源码。当前明确禁止进入版本库的常见目录包括：

- `.workbuddy/`、`.claude/`、`.codex/`、`.cursor/`、`.continue/`、`.opencode/`、`.agent/`、`.agents/`、`.pi_config/`
- `.vscode/`、`.zed/`、`.idea/` 这类本仓库已按本地配置处理的 IDE 目录

名单不是封闭集合。出现新的类似 `.xxx/` 目录时，若用途或归属不清楚，先调查并确认，
再决定是否应进入项目；不得直接 stage。确认属于本地工具状态后，应同时补充 `.gitignore`
和 `scripts/release-audit.mjs` 的明确路径规则。不要用 `.*` 等规则忽略所有隐藏文件；
`.github/`、`.husky/`、`.myharness/`、`.gitattributes`、`.gitignore`、`.npmrc` 等合法项目
内容必须继续保留。

`.gitignore` 只阻止尚未跟踪的文件进入候选列表，不能解除已经 tracked 的文件。已跟踪的本地状态目录还必须从 index 移除，并由 audit 和 hooks 阻止再次进入。

## Stage 规则

- stage 前先检查 `git status --short --branch`，逐项确认新增内容是谁产生的、是否属于当前任务。
- 默认精确 stage 当前任务涉及的路径。不要用 `git add .`、`git add -A` 代替文件审查；
  只有在逐项确认整个工作区的新增、修改和删除都属于本次任务或已明确允许提交后才可使用。
- 不得把其他 Agent、其他任务或用户留下的无关改动一起提交。文件已 staged 也仍需重新检查。
- 任何 stage/unstage、`git rm`、`git update-index` 等 index 写操作前，先读本文。

## Commit 前检查

提交前逐项确认：

1. 当前 branch、`git status --short --branch` 和工作区已有改动。
2. staged 路径与新增文件/目录、删除文件；确认每项都属于本次任务。
3. `git diff --cached --stat`、`git diff --cached --name-status` 和完整 `git diff --cached`；必要时结合未暂存 diff 判断最终内容。
4. staged 内容没有本地运行数据、Agent/Harness/IDE 状态目录、日志、缓存、临时/下载文件、构建产物或不应公开的二进制/runtime。
5. 没有 credential、token、cookie、session 私密内容、authorization header、真实用户路径或其他敏感数据；也没有未经解释的异常大文件。
6. 运行 `node scripts/release-audit.mjs --staged`。该审计检查 staged 文件内容，并检查整个 index 中的禁止工具目录；不能因为文件已经 staged 或以前已 tracked 就跳过审查。
7. 不使用 `--no-verify` 绕过 hook，除非用户明确要求并确认原因。

敏感信息审查只记录类别和路径，不复制真实值到报告、聊天或提交信息中。

## Push 前检查

Push 会修改远端 ref。执行前确认：

1. 当前 branch、`HEAD` SHA、remote、upstream 和 `git status --short --branch`。
2. 对照正确 remote/upstream；必要时先 `git fetch <remote>`，再检查 ahead、behind 或
   divergence。远端有新提交或发生分叉时先解决，不要猜测目标。
3. 列出本次实际要推送的 commits，并审查这些 commit 相对 upstream 的新增、修改和删除路径及 diff。
4. 审查将进入目标 ref 完整 tree 的敏感内容和 Agent/Harness/IDE 本地目录；运行
   `node scripts/release-audit.mjs --ref HEAD`，并确认 pre-push hook 会对 Git 提供的待推送
   SHA 执行同一完整 tree audit。
5. 确认 remote 名称、目标 branch/tag 和所有 refspec。禁止在影响范围不明时使用 `git push --all`、`git push --mirror`、`git push --force` 或 `git push --force-with-lease`。

只有明确需要改写历史时才考虑 force push；先确认原因、目标 remote/ref 和影响范围。不得把它当作普通失败恢复手段。

## Push 后验证

命令返回成功不等于远端状态已验证。至少检查：

- 远端目标 branch/tag 的 SHA、remote 和 ref 名称正确；本地 `HEAD` 与预期远端目标一致。
- GitHub Actions 是否为该 commit 生成了对应 run，以及 CI 的真实结果。CI 尚未生成、仍在运行或失败时要如实报告；失败时定位真实原因，不删除测试、弱化断言、吞异常或修改无关功能来制造全绿。

## 已进入历史的敏感信息

若发现真实 secret、credential、token、cookie 或用户私密数据已经进入 commit/history，立即
停止继续 Push。记录受影响 commit/ref 和类别，不复制 secret 值；先撤销或轮换 credential，
再根据实际情况制定历史清理方案。新增“删除文件”的 commit 不会清除旧历史。无敏感信息的
本地工作目录可由普通新 commit 从后续远端 tree 删除；不要仅为本地工作目录擅自重写历史。
