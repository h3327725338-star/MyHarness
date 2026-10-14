# 非 Git 子代理文件镜像

`agent`、`workflow` 和 `ultracode` 共用 `runExploreBatch()`。确认工作区不是 Git 仓库后，每个只读或读写任务先得到独立的普通文件副本，复制完成后才启动 worker。相对目录结构、中文和空格文件名保留；不自动初始化 Git，不创建宿主硬链接、符号链接或 Junction，不写回修改。Git 只读任务仍在原工作区运行，Git 读写任务仍使用既有 Worktree 与 workspace snapshot；Git 探测故障会明确报错，不冒充普通目录。

## 过滤

目录名在任意层级按完整名称、忽略大小写匹配，进入前就跳过：

- 依赖：`node_modules`、`bower_components`、`.venv`、`venv`。
- 构建产物：`build`、`dist`、`target`、`out`、`coverage`。
- 缓存：`.cache`、`.next`、`.nuxt`、`.turbo`、`.parcel-cache`、`.pytest_cache`、`.mypy_cache`、`.ruff_cache`、`__pycache__`、`.gradle`。
- 仓库及系统目录：`.git`、`.hg`、`.svn`、`$RECYCLE.BIN`、`System Volume Information`。
- 私密目录：`.ssh`、`.aws`、`.azure`、`.gnupg`。

文件排除：`Thumbs.db`、`desktop.ini`、`.DS_Store`、`id_rsa`、`id_ed25519`、`id_ecdsa`、`id_dsa`、`credentials`、`credentials.json`、`auth.json`、`.npmrc`、`.netrc`、`.pypirc`、以 `.key`/`.pfx`/`.p12` 结尾的文件，以及 `.env`/`.env.*`（保留 `.env.example`、`.env.sample`、`.env.template`）。`.myharness` 内另外跳过 `sessions`、`cache`、`trace`、`data` 和凭据文件。所有链接及非普通文件不复制、不跟随，包括坏链接和 Junction。

不按 PDF、Office、图片或源码扩展名排除，不泛化排除所有隐藏文件或 JSON。`build` 等名称可能包含任务输入；过滤项明确报告，不解释为宿主没有该文件。黑名单仅控制复制；当前文件工具仍能通过原工作区绝对路径补读，不代表凭据读取权限隔离。

## 预算与一致性

内置预算：单文件 256 MiB、累计 1 GiB、50,000 个目录项、深度 128、并发 4。不是新的用户设置。超过大小或深度限制、文件复制失败时记录镜像不完整；超过目录项预算或没有复制到任何可用文件且发生复制缺失时准备失败，不启动 worker。最多显示 20 条具体遗漏，其余用数量汇总。

异步、分块复制关闭所有文件句柄后才收尾；目录遍历使用显式栈，打开的目录自动关闭。源文件复制前后核对类型、身份、大小和修改时间，变化的副本删除并记录遗漏；不宣称全目录原子快照，也不自动重试不稳定文件。云盘下载和大文件 I/O 会影响耗时，不保证任意工作区毫秒级装配。任务开始前显示准备状态，并在任务提示中提供文件数、字节数与耗时。

## 权限

worker 的 cwd 是镜像的 `workspace`。相对路径读取及沙箱内写入沿用既有工具守卫；沙箱外 Shell 路径、宿主写入、Git 改库命令和嵌套派发仍禁止。没有给 bash/pwsh 增加原工作区豁免。不加载普通项目扩展或项目上下文文件，沿用 delegated worker 的资源装配规则。工具层检查不是操作系统级安全隔离，脚本内部行为仍有原有边界限制。

## 生命周期

所有权记录放在 worker cwd 的父目录，不放进镜像文件列表。记录父进程、worker PID、随机 token、宿主与容器路径。每个任务 finally 清理，批次 finally 再兜底；装配失败或取消也清理。确认 worker 仍活着或无法证明退出时拒绝删除并报告。会话异步注销有界等待后台 Explore 清理。

删除前验证专有临时根、目录真实路径和所有权，不跟随内部链接，仅删除链接本身；失败有限重试并保留记录。启动延迟维护仅回收父进程和 worker 都已退出、记录合法的目录；无记录、损坏记录、活动目录和历史其他沙箱不自动删除。强杀、断电、外部占用或 PID 重用可能延迟回收，不承诺即时零残留。

实现：`src/agent/delegation/non-git-sandbox.ts`；兼容入口：`worktree-sandbox.ts`；批次编排：`src/tools/sub-agent.ts`。
