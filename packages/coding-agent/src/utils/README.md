# utils/ — 无领域归属的基础工具

## 说明

### 职责

只放不属于任何业务领域、可复用、副作用小的辅助代码。按用途分组如下。

| 分组 | 文件 |
| --- | --- |
| 文件写入 | `atomic-write.ts`（原子替换、临时文件清理） |
| 路径 | `paths.ts`（规范化、identity key、相对路径显示、Git 仓库根） |
| 进程与 Shell | `child-process.ts`（spawn、进程树终止）、`windows-job.ts`（Windows 作业对象：命令进程树整体结束）、`shell.ts`（Shell 配置、环境、分离子进程跟踪）、`shell-command-lexer.ts`（保守的 Shell 命令词法切分）、`sleep.ts`（可取消等待） |
| 文本与解析 | `frontmatter.ts`、`json.ts`（去注释）、`ansi.ts`（去 ANSI）、`changelog.ts` |
| 图片 | `image-resize.ts` / `image-resize-core.ts` / `image-resize-worker.ts`、`image-convert.ts`、`image-process.ts`、`exif-orientation.ts`、`mime.ts`、`photon.ts`、`jxl-decode-worker.ts` |
| 输入文件 | `file-preprocess.ts`（富文档转文本/页图）、`input-image-attachments.ts` |
| 桌面集成 | `open-browser.ts`、`popup-notification.ts`（任务结束弹窗的内容与命令） |
| 自身信息 | `myharness-invocation.ts`（如何再次启动自己）、`myharness-user-agent.ts` |
| 外部工具 | `tools-manager.ts`（`fd`、`rg` 等的定位与下载） |
| 兼容入口 | `git.ts`、`git-command.ts`（已废弃，只 re-export `git/repository/`） |

### 依赖

- 依赖：`src/config.ts`；少量文件依赖具体领域：`file-preprocess.ts` → `agent/vision/document-corpus.ts`，`popup-notification.ts` → `agent/runtime/run-state.ts`，`git*.ts` → `git/repository`。
- 被依赖：几乎所有领域。

## 维护

- 往这里加文件前先问：它属于哪个领域？有归属就放回那个领域。业务状态和业务规则不进 `utils/`。
- 不要用 `utils/` 绕开领域边界（例如在这里再写一份 Git 调用或 Session 读写）。
- `git.ts`、`git-command.ts` 是兼容入口，新代码直接从 `git/repository/` 导入。
- `image-resize-worker.ts` 和 `jxl-decode-worker.ts` 是独立 worker 入口，被 `build:binary` 单独列为编译入口；改名要同步 `package.json`。
- 原子写、进程树终止是多处依赖的安全基础，改动需要跑 `atomic-write-recovery.test.ts`、`bash-close-hang-windows.test.ts`、`exec.test.ts` 等。
- Windows 上执行命令的四处（`platform/process/exec.ts`、`tools/shell/bash.ts`、`tools/shell/pwsh.ts`、`tools/sub-agent.ts`）在 spawn 后调用 `containProcessTree()`，把命令放进自己的作业对象；取消时 `runWindowsTaskkill()` 先结束作业对象，作业对象里的进程（包括 `taskkill /T` 找不到的、父进程已退出的后代）一起结束，结束成功就不再运行 `taskkill`。作业对象不允许任何进程脱离（Git Bash 的运行时在允许时会脱离），也没有“关闭即结束”：命令正常结束不影响它留下的后台进程。它嵌套在 Node 自己的作业对象里，所以这些后台进程会在服务进程退出时一起结束（桌面版本来就这样）。作业对象经可选依赖 `koffi` 调用系统接口，加载失败时照旧只用 `taskkill`。
- 相关测试：`paths.test.ts`、`shell-command-lexer.test.ts`、`frontmatter.test.ts`、`image-*.test.ts`、`file-preprocess.test.ts`、`popup-notification.test.ts`、`changelog.test.ts`。
