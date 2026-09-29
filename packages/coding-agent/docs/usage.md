# MyHarness 使用说明

本页整理 Quickstart 中未涵盖的日常使用方法。

## 交互模式（Interactive Mode）

界面主要分为四个区域：

- **启动 Header**：显示快捷键、已加载的 context files、prompt templates、skills 和 extensions；
- **Messages**：用户消息、assistant 回复、tool calls、tool results、notifications、errors 和 extension UI；
- **Editor**：输入内容的区域；边框颜色表示当前的 thinking level；
- **Footer**：显示工作目录、Git branch、session name、累计费用（或 DeepSeek account balance）、context 使用量、auto-compaction 状态、Provider/model、thinking level 和 extension 状态。费用包含 assistant 回复、tools 报告的使用量以及 summary generation 的费用。

Editor 可能会临时被内置 UI（例如 `/settings`）或 extension 提供的 custom UI 替换。

### Editor 功能

| 功能 | 操作 |
|---------|-----|
| 引用文件 | 输入 `@`，模糊搜索项目文件 |
| 路径补全 | 按 Tab 补全路径 |
| 多行输入 | Shift+Enter 或 Ctrl+J |
| 复制选区 | Ctrl+C 复制选中的文本 |
| 图片 | Ctrl+V 粘贴；Windows 使用 Alt+V，也可以将图片拖入 terminal |
| Shell 命令 | `!command` 执行命令并把输出发送给 model |
| 隐藏 Shell 命令 | `!!command` 执行命令但不发送输出给 model |
| 外部编辑器 | Ctrl+G 打开 `externalEditor`、`$VISUAL`、`$EDITOR`；Windows 默认使用 Notepad，其他系统默认使用 `nano` |

全部快捷键和自定义方式见[快捷键说明](keybindings.md)。

### Transcript 显示

默认 Transcript 会折叠显示 reasoning 和 tool output。流式 thinking 显示为 `· Thinking... Ns`，完成后显示为 `· Thought for Ns`，具体内容不会直接展开。Tool calls 显示为带状态颜色的 `●`/`⏺` 行，下面是缩进的 `⎿` 摘要；调用状态会依次经过 `Queued…`、`Running…`，最后显示成功或失败。

按 Ctrl+O 展开 Transcript 详情。展开后，最新的 thinking block 会显示为 `∴ Thinking…`，并恢复完整的 tool output、diff、图片和 extension renderer。更早的 thinking blocks 仍保持折叠。Ctrl+O 只改变当前视图；`hideThinkingBlock` 用于控制启动时的默认状态。

## Slash Commands（斜杠命令）

在 Editor 中输入 `/` 打开 command completion。Extensions、已安装的 skills 和已加载的 prompt templates 都可以向列表中添加命令。

内置 Slash Commands：

| Command | 说明 |
|---------|-------------|
| `/settings` | 打开 Settings 菜单 |
| `/model` | 切换 model |
| `/new` | 开始新的 session |
| `/workspace` | 打开 Workspace / Chat 管理侧栏 |
| `/compact [prompt]` | 手动压缩 context，可选自定义 instructions |
| `/effort` | 循环切换 thinking/effort level |
| `/commit` | 提交当前 workspace 的本地 Git changes |
| `/push` | 将已有 commit 推送到当前 upstream，并验证 remote 与当前 commit 的 CI |
| `/restore` | 丢弃所有未提交的改动和未跟踪文件，把仓库退回最新提交（HEAD）；执行前列出会丢失的内容并要求确认 |
| `/undo` | 只保留或撤销当前任务检查点记录的修改 |
| `/workflow <task>` | 运行 multi-agent workflow |
| `/ultracode <task>` | 使用更严格的调查流程处理复杂 task |

`/workflow` 和 `/ultracode` 的 Task 可以写在同一行，也可以在下一行输入：

```text
/workflow
检查登录系统的实现、配置和测试
```

`/restore` 以当前 HEAD 为目标，不区分提交是由 `/commit` 还是 `git commit` 创建；它会 `git reset --hard` 并删除未跟踪文件（包括 Windows 保留名文件如 `nul`），但保留 `.gitignore` 忽略的文件、嵌套 Git 仓库和 MyHarness 的 agent 目录，且无法撤销。`/undo` 基于任务检查点，只撤销这次任务的修改，任务开始前已有的未提交改动会保留。

`/commit` 只负责创建本地 commit；`/push` 只发布已经存在的 commit。`/push` 会先 fetch 当前 branch 的真实 upstream，拒绝 remote-ahead 或 divergence，只推送当前 branch，验证 remote SHA，并在支持的 GitHub Actions 连接可用时等待仓库自身配置的 branch-push CI；无法验证 CI 时会明确报告未确认，不会声称成功。它不会自动 stage、commit、stash、force-push、推送 tags 或其他 refs；未提交的 staged、unstaged 和 untracked 文件会保留并在结果中报告。

`/workflow` 会要求 main AI 创建一个包含一个或多个 sequential phases 的 workflow。每个 phase 可以并行运行多个独立的 Explore tasks，后续 phase 会收到前一阶段的结果。`/ultracode` 会附加更严格的中文 instructions：从不同角度调查、独立质疑重要结论、在第一次运行不足时继续执行后续 Ultracode runs，并在 main AI 修改后验证结果。Workflow children 使用配置的 **Sub Agent** model 和 thinking level；它们不能编辑文件，也不能创建 child agents。

其他命令可以由 extensions 提供，具体以对应 extension 的文档为准。

## Message Queue（消息队列）

Agent 工作期间也可以继续发送消息：

- **Enter**：加入 steering message，在当前 assistant turn 完成 tool calls 后发送；
- **Alt+Enter**：加入 follow-up message，在 agent 完成所有工作后发送；
- **Escape**：中止当前工作，并将已排队的消息恢复到 Editor；
- **Alt+Up**：将排队的消息取回 Editor。

在 Windows Terminal 中，Alt+Enter 默认用于全屏。若要让 MyHarness 接收这个快捷键，请按 [Terminal 设置](terminal-setup.md) 中的说明重新映射。

可以在 [Settings](settings.md) 中配置消息发送方式：`steeringMode` 和 `followUpMode` 可以设置为默认的 `"one-at-a-time"`（逐条等待回复）或 `"all"`（一次发送全部排队消息）。`transport` 用于选择支持多种 transport 的 Provider 的传输偏好：`"sse"`、`"websocket"`、`"websocket-cached"` 或 `"auto"`。

## Sessions（会话）

Sessions 默认保存到项目根目录 `data/workspaces/<workspace-id>/sessions/<session-id>/conversation/`，由稳定的 Workspace/Session ID 组织；Session 的工作目录保存在 JSONL header 中。

```bash
myharness -c                  # 继续最近的 session
myharness -r                  # 浏览并选择 session
myharness --no-session        # 临时模式，不保存 session
myharness --name "my task"    # 启动时设置 session 显示名称
myharness --session <path|id> # 使用指定的 session file 或 session ID
myharness --session-id <id>   # 使用准确的 project session ID
myharness --fork <path|id>    # 将 session 分支为新的 session file
```

Session 管理：

- `/new` 开始新的 session；
- `/compact` 总结较早的消息，以释放 context；
- 启动时使用 `MyHarness -r` 打开 session picker。

详细说明见 [Sessions](sessions.md) 和 [Compaction](compaction.md)。

## Context Files（上下文文件）

MyHarness 启动时会从以下位置加载 `AGENTS.md` 或 `CLAUDE.md`：

- `~/.myharness/agent/AGENTS.md`：全局 instructions；
- 从当前工作目录向上遍历的 parent directories 和当前目录；最上层 ancestor 到当前 cwd 的顺序进入 system prompt；
- 每个目录按 `AGENTS.md`、大小写变体、`CLAUDE.md`、大小写变体选择可读文件。

Context files 可用于声明项目约定、命令、安全规则和个人偏好。使用 `--no-context-files` 或 `-nc` 可以关闭加载。

如果从 MyHarness 仓库根目录或其子目录启动，根 `AGENTS.md` 会作为适用的项目
上下文加载；它同时是本仓库 Agent 开发规则的入口。后一个职责属于仓库协作，
不要把它复制到根 `system-prompts/`，也不要把运行时 context files 和产品静态
System Prompt 当成同一套规则系统。

### System Prompt Files（系统提示文件）

使用以下文件替换默认 system prompt：

- 受信任项目中的 `.myharness/SYSTEM.md`；
- 如果项目未受信任，或项目文件不存在，则使用全局的 `~/.myharness/agent/SYSTEM.md`。

项目 `SYSTEM.md` 会覆盖全局同名文件，不会与全局文件简单叠加。若只想在默认
prompt 后追加内容，可以在项目或全局位置使用 `APPEND_SYSTEM.md`；它也遵循同样
的项目优先、未受信任时回退全局的选择规则。`AGENTS.md`/`CLAUDE.md` 是独立的
项目上下文，Project Trust 不会跳过它们（除非使用 `--no-context-files`）。

### Project Trust（项目级信任）

完整说明见 [Settings 中的 Project Trust](settings.md#project-trust)。概要如下：

- 交互模式启动时，如果项目包含本地 resources 且没有已保存的决定，MyHarness 会先询问是否信任项目；
- Non-interactive modes 使用 `defaultProjectTrust`：`ask`/`never` 跳过项目 resources，`always` 表示信任；
- 使用 `--approve`/`-a` 或 `--no-approve`/`-na` 可对单次 command 覆盖设置；
- `MyHarness config` 和 package commands 使用相同的流程；`MyHarness update` 不会询问；
- 已保存的决定写入 `~/.myharness/agent/trust.json`；`/settings` 只修改全局 fallback，不会直接添加或删除当前项目的 trust entry。

> 本节是对 README.md 中内容的摘要。更新 Project Trust 行为时，请保持两处同步。


## 导出 Sessions

使用 CLI 的 `--export` flag 将 session file 导出为 HTML：

```bash
myharness --export data/workspaces/.../sessions/.../conversation/session.jsonl
myharness --export session.jsonl output.html
```

## CLI 参考

```bash
myharness [options] [@files...] [messages...]
```

### Package Commands（Package 命令）

```bash
myharness install <source> [-l]     # 安装 package；-l 表示 project-local
myharness remove <source> [-l]      # 删除 package
myharness uninstall <source> [-l]   # remove 的 alias
myharness update [source]           # 更新一个 package source
myharness update --all              # 更新全部已安装 package（等同于 --extensions）
myharness update --extensions       # 只更新已安装 packages
myharness update --models           # 只刷新 model catalogs
myharness update --extension <src>  # 更新一个 package
myharness list                      # 列出已安装 packages
myharness config [-l]               # 编辑 settings；-l 表示 project overrides
```

这些 commands 用于管理 MyHarness packages。卸载 MyHarness 本身请参阅[快速开始中的卸载说明](quickstart.md#uninstall)。`MyHarness config` 和 project package commands 支持 `--approve`/`--no-approve`，可在单次 command 中信任或忽略 project-local settings。`MyHarness update` 不会询问 Project Trust。

详细说明见 [MyHarness Packages](packages.md)，包括 package sources 和安全注意事项。

### Modes（运行模式）

| Flag | 说明 |
|------|-------------|
| default | Interactive mode |
| `--web` | 启动本机 [Web UI](web-ui.md)（只监听 `127.0.0.1`）；可配合 `--port <n>`（默认 7878）和 `--no-open`；不能与 `--print`、`--mode`、`--list-models` 同时使用 |
| `-p`、`--print` | 输出回复后退出 |
| `--mode text` | Text output；TTY 中使用 interactive mode，否则使用 print mode |
| `--mode json` | 将所有 events 以 JSON lines 输出，详见 [JSON mode](json.md) |
| `--export <file>` | 将 session 导出为 HTML |

当前 CLI 不接受 `--mode rpc`。需要进程内集成时使用 SDK，需要 structured event stream 时使用 `--mode json`。

在 print mode 中，MyHarness 还会读取 piped stdin，并将其合并到初始 prompt：

```bash
cat README.md | myharness -p "Summarize this text"
```

### Model Options（Model 选项）

| Option | 说明 |
|--------|-------------|
| `--provider <name>` | Provider，例如 `anthropic` |
| `--model <pattern>` | Model pattern 或 ID；支持 `provider/id` 和可选的 `:<thinking>` |
| `--api-key <key>` | API Key，覆盖 environment variables |
| `--thinking <level>` | `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` |
| `--models <patterns>` | 用逗号分隔的 patterns，用于 Ctrl+P cycling |
| `--list-models [search]` | 列出可用 models |
| `--context-window <size>` | 覆盖 context window，例如 `256K` |

### Session Options（Session 选项）

| Option | 说明 |
|--------|-------------|
| `-c`、`--continue` | 继续最近的 session |
| `-r`、`--resume` | 浏览并选择 session |
| `--session <path\|id>` | 使用指定的 session file 或 partial UUID |
| `--session-id <id>` | 使用准确的 project session ID；找不到时创建。不能与 `--session`、`--continue` 或 `--resume` 一起使用 |
| `--fork <path\|id>` | 将 session file 或 partial UUID 分支为新的 session |
| `--session-dir <dir>` | 自定义 session storage directory |
| `--no-session` | 临时模式，不保存 session |
| `--name <name>`、`-n <name>` | 启动时设置 session 显示名称 |

### Tool Options（Tool 选项）

| Option | 说明 |
|--------|-------------|
| `--tools <list>`、`-t <list>` | 只允许指定的 built-in、extension 和 custom tools |
| `--exclude-tools <list>`、`-xt <list>` | 禁用指定的 built-in、extension 和 custom tools |
| `--no-builtin-tools`、`-nbt` | 禁用 built-in tools，但保留 extension/custom tools |
| `--no-tools`、`-nt` | 禁用全部 tools |

内置 tools：`read`、`bash`、`pwsh`、`edit`、`write`、`grep`、`find`、`ls`、`symbols`、`agent`、`workflow`、`ultracode` 和 `github`。默认启用 `read`、`bash`、`pwsh`、`edit`、`write`、`symbols` 和 `github`；`grep`、`find`、`ls` 为 opt-in；`agent`、`workflow` 和 `ultracode` 在 `/settings` 的 **Sub Agent** 中配置。Child agents 不会获得 `edit` 或 `write`，但它们的 Bash guard 只拦截已知的 mutating command patterns，并不是严格的 read-only sandbox。

### Resource Options（Resource 选项）

| Option | 说明 |
|--------|-------------|
| `-e`、`--extension <source>` | 从 path、npm 或 git 加载 extension；可重复指定 |
| `--no-extensions`、`-ne` | 关闭 extension discovery |
| `--skill <path>` | 加载 skill；可重复指定 |
| `--no-skills`、`-ns` | 关闭 skill discovery |
| `--prompt-template <path>` | 加载 prompt template；可重复指定 |
| `--no-prompt-templates`、`-np` | 关闭 prompt template discovery |
| `--theme <path>` | 加载 theme；可重复指定 |
| `--no-themes` | 关闭 theme discovery |
| `--no-context-files`、`-nc` | 关闭 `AGENTS.md` 和 `CLAUDE.md` discovery |

可以将 `--no-*` 与显式 flag 组合，精确指定需要加载的资源，并忽略 settings。例如：

```bash
myharness --no-extensions -e ./my-extension.ts
```

### Other Options（其他选项）

| Option | 说明 |
|--------|-------------|
| `--system-prompt <text>` | 向默认 system prompt 追加 instructions；context files 和 skills 仍会追加 |
| `--append-system-prompt <text>` | 向 system prompt 追加文本 |
| `--verbose` | 强制显示详细 startup 信息 |
| `--offline` | 禁用 startup network operations（等同于 `MYHARNESS_OFFLINE=1`） |
| `-a`、`--approve` | 本次运行信任 project-local files |
| `-na`、`--no-approve` | 本次运行忽略 project-local files |
| `-v`、`--version` | 显示版本 |

### File Arguments（文件参数）

在文件前加 `@`，即可将文件包含在消息中：

```bash
myharness @prompt.md "Answer this"
myharness -p @screenshot.png "What's in this image?"
myharness @code.ts @test.ts "Review these files"
myharness -p @report.pdf "Summarize the text, charts, and page layout"
myharness -p @demo.mp4 "Describe the visible workflow"
```

对于本地文件，MyHarness 会在提交给 model 前预处理现代 Office documents、PDF、SVG、design/image formats 和 video keyframes。PDF pages 和现代 Office 内容还会写入持久化 document corpus，其中包含稳定的 source labels、exact-text paths、可恢复的 page manifests 和独立的 visual transcriptions。`@` 参数可以指定支持的文件或目录，递归扫描 documents、images、design files 和 videos。某个 item 失败会被报告，但不会终止同一批次中的其他 items。Audio 和旧版 DOC/XLS/PPT 不会被处理。确切的 format 列表和限制见 [Vision Assistant 设置](settings.md#visionassistant)。

### 示例

下面的 model ID 只是示例；可以先登录内置的 OpenAI ChatGPT Provider，或在 `models.json`、Settings、extension 中配置对应 Provider/model。

```bash
# 带初始 prompt 的 Interactive mode
myharness "List all .ts files in src/"

# Non-interactive mode
myharness -p "Summarize this codebase"

# 使用 piped stdin 的 Non-interactive mode
cat README.md | myharness -p "Summarize this text"

# 命名的 one-shot session
myharness --name "release audit" -p "Audit this repository"

# 使用已配置的其他 model
myharness --provider anthropic --model claude-opus-4-6 "Help me refactor"

# 使用带 Provider prefix 的 model
myharness --model anthropic/claude-opus-4-6 "Help me refactor"

# 使用 thinking level shorthand
myharness --model claude-opus-4-6:high "Solve this complex problem"

# 限制 model cycling
myharness --models "claude-*"

# Read-only mode
myharness --tools read,grep,find,ls -p "Review the code"

# 禁用一个 extension 或 built-in tool，同时保留其他能力
myharness --exclude-tools ask_question
```

### Environment Variables（环境变量）

| Variable | 说明 |
|----------|-------------|
| `MYHARNESS_CODING_AGENT_DIR` | 覆盖 config directory；默认是 `~/.myharness/agent` |
| `MYHARNESS_CODING_AGENT_SESSION_DIR` | 覆盖 session storage directory；会被 `--session-dir` 覆盖 |
| `MYHARNESS_PACKAGE_DIR` | 覆盖 package directory，适用于 Nix/Guix store paths |
| `MYHARNESS_OFFLINE` | 禁用 startup network operations，包括 package update checks 和 install/update telemetry |
| `MYHARNESS_TELEMETRY` | 覆盖 install/update telemetry 和 Provider attribution headers：`1`/`true`/`yes` 或 `0`/`false`/`no` |
| `MYHARNESS_INSTALL_TELEMETRY_URL` | 可选的 trusted install/update telemetry endpoint base URL；默认未设置 |
| `MYHARNESS_CACHE_RETENTION` | 设置为 `long`，在支持的情况下启用 extended prompt cache |
| `VISUAL`、`EDITOR` | 当 `externalEditor` 未设置时，作为 Ctrl+G 的 fallback external editor；Windows 默认使用 Notepad，其他系统默认使用 `nano` |

## 设计原则

MyHarness 将大部分 workflow-specific behavior 放在 extensions、skills、prompt templates 和 packages 中。同时，它包含供 `/workflow` 和 `/ultracode` 使用的专用 built-in `workflow` 和 `ultracode` tools。

MyHarness 有意不内置 MCP、permission popups、to-dos 或 background bash。`agent`、`workflow` 和 `ultracode` tools 用于 read-only exploration，默认关闭。其他 orchestration styles 仍可以通过 extensions、packages，或 containers、tmux 等 external tools 构建。
