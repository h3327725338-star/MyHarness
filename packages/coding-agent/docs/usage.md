# MyHarness 使用说明

MyHarness 只提供本机浏览器 Web UI，不再提供终端聊天、print、JSON 或 RPC 输出模式。

## 启动

Windows 源码 checkout：双击仓库根目录 `dev-web.cmd`。服务在后台运行；需要查看日志时使用 `dev-web.cmd --console`。已构建入口为 `myharness`，它同样启动 Web。

启动参数仍可指定 `--port`、`--no-open`、Provider、模型、Session 和资源；使用 `web-source.ps1 --help` 查看当前完整列表。`web-source.ps1` 直接运行源码并保留调用者的工作目录；`web-runtime.ps1` 负责仓库开发环境检查。

## 对话与命令

在浏览器输入框发送消息，使用 `@` 引用文件，或粘贴、拖入附件。`!command` 执行 Shell 命令并把结果交给模型，`!!command` 执行但不发送输出给模型。页面的 Terminal 面板是独立 Shell，不是 Agent 的终端聊天界面。

在输入框输入 `/` 查看内置命令、扩展命令、Skills 和 Prompt templates。

| 命令 | 作用 |
| --- | --- |
| `/settings`、`/model`、`/effort` | 设置、模型与思考强度 |
| `/new`、`/workspace` | 新会话与 Workspace 管理 |
| `/compact` | 压缩上下文 |
| `/git` | Git 管理 |
| `/commit` | 创建本地提交 |
| `/push` | 发布已有提交并检查远端结果 |
| `/restore` | 确认后丢弃未提交改动及未跟踪文件；不可撤销 |
| `/undo` | 仅保留或撤销本次任务检查点中的改动 |
| `/workflow`、`/ultracode` | 多智能体调查流程 |

`/push` 不自动提交，不强制推送。`/undo` 保留任务开始前已有的改动。进行中消息的引导或排队方式由设置中的“任务运行中”选项决定。

## 配置与资源

- Provider、API Key 与模型：浏览器 Settings → Providers；参见 [Providers](providers.md) 和 [Models](models.md)。
- 项目设置位于 `.myharness/settings.json`；全局设置位于 `~/.myharness/agent/settings.json`。
- 项目 Trust 控制项目配置与扩展加载；`AGENTS.md` / `CLAUDE.md` 是独立项目上下文，默认按目录层级加载。
- 自定义 System Prompt 与追加内容遵循项目优先、Trust 控制的加载规则，不简单合并项目和全局文件。
- Session、归档、分支与压缩参见 [Sessions](sessions.md)、[Session format](session-format.md) 和 [Compaction](compaction.md)。

页面布局、浏览器快捷键、启动生命周期、文件上传和重要限制统一见 [Web UI](web-ui.md)。SDK 集成见 [SDK](sdk.md)。
