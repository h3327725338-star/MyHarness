# Web UI

MyHarness 有两个同等的正式入口：终端里的 TUI，以及只在本机使用的浏览器 Web UI。两者共用同一个 `AgentSessionRuntime` / `AgentSession`、同一套 Session、Settings、Provider、Tool、Git checkpoint 和 Extension，没有第二套 Agent 逻辑。Web UI 是现有能力的另一个交互层，不是对 CLI 的重写。

## 启动

```powershell
# 源码 checkout（Windows）
.\dev.cmd --web
# 或直接双击仓库根目录的 dev-web.cmd：与 dev.cmd --web 相同，但服务在后台无窗口运行（见下）
# 或已构建的 CLI
myharness --web
```

| 参数 | 说明 |
| --- | --- |
| `--web` | 启动本地 Web UI，而不是 TUI。不能与 `--print`、`--mode`、`--list-models` 同时使用。 |
| `--port <n>` | 端口，默认 `7878`；被占用时依次尝试后面的 10 个端口；`0` 表示由系统分配。 |
| `--no-open` | 不自动打开默认浏览器（终端会打印 `MyHarness Web UI: http://127.0.0.1:<port>/`）。 |

**无窗口启动（Windows 源码 checkout）**：`dev-web.cmd` 不再占用控制台。它把工作交给 `dev-web.vbs`（wscript，本身没有控制台）后立即退出；`dev-web.ps1` 在已有实例（默认端口 7878 或 `--port`）时只打开浏览器，否则以隐藏方式运行 `dev.ps1 --web`，输出写入 `data/logs/web-launch.out.log` / `web-launch.err.log`，服务就绪（打印出地址）后退出。启动失败、进程提前退出或 180 秒仍未就绪时，会停止启动进程并弹出错误对话框（带日志尾部与日志路径）。服务用页面里的 **Quit MyHarness** 结束，整棵进程树一起退出。需要看控制台输出时用 `dev-web.cmd --console`（原来的可见窗口方式）。CLI 的 `dev.cmd` 与 `myharness` 不受影响。

其余参数照常生效：`--session`、`--continue`、`--model`、`--thinking`、`--no-extensions`、`--approve/--no-approve` 等；命令行里的初始 message / `@file` 会在启动后作为第一条消息发送。终端里按 `Ctrl+C`（或界面里的 **Quit MyHarness**）会停止服务并结束当前任务。

服务只监听 `127.0.0.1`，面向 Windows 桌面浏览器，单用户使用。不提供手机/平板适配、局域网访问或多人协作。

## 界面结构

```text
┌ 侧栏 ──────┬ 会话 ──────────────────────────────┬ 详情面板（可开关，可拖宽）┐
│ Workspaces │ 标题 · 状态 · 面板按钮               │ Changes │ Files │ Terminal │ Session │
│  └ Chats   │ 对话（安静阅读） + 运行摘要          │                          │
│            │ Composer（模型/推理力度/发送/停止）  │                          │
└────────────┴─────────────────────────────────────┴──────────────────────────┘
```

* **侧栏**：真实的 Workspace / Chat 结构（`WorkspaceStore` + `SessionManager.list`）。新建 Chat、切换 Chat、重命名（手动或 AI 生成标题）、删除、添加/移除 Workspace。Workspace 可展开/收起（带高度动画，不影响其中正在运行的 Chat）。行内状态槽位固定，运行中/等待/失败不会挤动标题；还没写入磁盘的进行中 Chat 也会列出，随时可切回。
* **文件夹选择器**（添加 Workspace）：类似资源管理器——后退/前进/上一级、可编辑并可点击的路径（面包屑）、快速访问（主目录/桌面/文档/下载）、盘符、已有 Workspace、筛选、新建文件夹、显示隐藏文件夹；只列目录，选中后显示完整路径再确认。
* **对话**：用户消息、运行摘要、最终回复。默认不展开 Thinking、读文件、搜索、命令和编辑，只显示一行摘要，例如 `Worked for 32s · 9 actions · 4 files changed`。
  * 第一层：摘要行（`Worked for …` / `Failed after …` / `Partially completed` / `Cancelled after …` / 运行中显示当前动作）。
  * 第二层：点开后是可读步骤。读文件、搜索、命令、编辑等用自然语言描述，连续同类动作聚合（“Read 8 files”），可继续展开单项；Thinking 有内容时可展开；sub-agent / workflow 显示阶段与任务进度。
  * 第三层：单项的 Raw details——真实 tool name、arguments、stdout/stderr、exit code、耗时、result details。
  * 需要用户处理的状态永远不折叠：等待回答/审批、失败、部分完成、取消都有独立的横幅，横幅会说明失败原因、改了几个文件、跑了几条命令，并提供 View changes / Retry。
* **Composer**：一个输入卡。模型选择（Provider 分组、搜索、刷新 catalog）、推理力度、上下文用量环（点击弹出真实用量：已用 / 窗口 / 百分比 / 剩余，以及按 System Prompt、项目说明、Skills、记忆策略、工具定义、各类消息分组实际测得的构成；数据来自 `GET /api/context`，用与自动压缩相同的估算器，没有可计算数据的类别不显示）、附件（图片：粘贴/拖放/选择）、`/` 命令与 skills、`@` 文件提及、`!cmd` / `!!cmd` 直接运行 shell、历史消息（↑/↓）。发送与停止在同一个位置切换。
* **详情面板**：
  * **Changes**：这一轮到底改了什么。文件列表 + 真实的 unified / side-by-side diff；`This task` 与 `Working tree`（Git 未提交改动）两个范围；Git 操作条（Commit… / Push… / Undo task… / 更多）。
  * **Files**：只读的工作区文件树（带 Git 状态与“本轮改动”标记）、文件名搜索、文件查看（语法高亮、图片预览、跳转到行）、`@` 提及到 prompt。
  * **Terminal**：本 Session 的每一条 shell 命令（Agent 的 `bash`/`pwsh` 工具和你自己的 `!` 命令）：命令、cwd、状态、耗时、exit code、真实输出（保留 ANSI 颜色）、截断与完整输出路径；底部可直接运行新的命令。
  * **Session**：上下文用量与压缩、Session 统计、Git checkpoint、分支树（导航 / fork）、Tools（可开关）、Skills、Prompt templates、Extensions、项目上下文文件、Reload resources。
* **设置**（`Ctrl+,`）：外观（界面语言/主题/密度/动画/阅读宽度/浏览器通知，保存在浏览器）；Agent、Assistants（Auto Memory / Sub-agent / Vision）、Tools（Web search、Code Intelligence）、Network、Shell、Safety（Project Trust、默认信任策略）；Providers（启停、API Key 多密钥管理、OAuth 登录、`models.json` 自定义 Provider）。
* **命令面板**（`Ctrl+K`）：动作、Chat、文件的统一搜索。
* **行内命令面板**：在 Composer 输入 `/settings`、`/model`、`/effort`、`/git`、`/commit`、`/push`、`/restore`、`/undo` 并回车，会在输入框上方展开一个类似 CLI 菜单的多级面板（不是设置页）：↑/↓/PgUp/PgDn/Home/End 移动，Enter 或 → 进入/确认，Space 切换开关，←/Backspace/Esc 返回上一级（有筛选时先清筛选），可键入筛选；鼠标可选。`/settings` 覆盖全部设置分类、Provider 与 API Key 管理；`/git` 覆盖 Worktree、历史、仓库登记。一次性命令（如 `/new`、`/compact`）仍直接执行，候选列表与搜索保留。

### 界面语言

设置 → 外观 → **界面语言**（或命令面板里的 Language 项）在 English 与简体中文之间切换，立即生效并保存在浏览器；默认 English。只翻译 MyHarness 自己的界面文字（菜单、按钮、状态、设置、提示、空状态、错误、运行状态），不翻译用户与 Agent 的消息、代码、文件内容和命令输出。

* 机制：`web/js/i18n.js` 以英文原文为 key（`t()` / `N_()` / `tNodes()` / `count()`），中文词典只放在 `web/js/locales/zh-CN.js`；源码里其他位置不出现中文（测试强制）。
* 服务端产生的文本：设置项、错误等英文文本由词典翻译；终端侧固定为中文的文本（运行状态、Git 阶段、命令说明等）通过 `serverTextEn` 在英文模式下映射为英文，未知的中文不会显示在英文界面里。CLI 的输出不变。
* 新增界面文字：用 `t("English text")` 并在 `zh-CN.js` 补条目；`test/web-i18n.test.ts` 会检查缺失的翻译、占位符不一致和源码里的中文。

### 同时运行多个会话

多个 Chat 可以同时运行，互不影响：每个打开的 Chat 是服务端 `WebHostHub`（`hub.ts`）里的一个 slot，拥有独立的 `AgentSessionRuntime`（session、cwd 绑定的服务、Git checkpoint、对话框队列、消息与工具流）。请求通过 `x-myharness-slot` 头（或 `slot` 查询参数）定位 slot，SSE 事件带 `slot` 字段，前端 `store.js` 为每个 slot 保存独立状态并只渲染当前 slot。切换 Chat 只是换显示哪个 slot，后台 Chat 继续运行，回来时看到的是真实状态；侧栏用 `slots` 事件显示每个 Chat 的运行/等待/结果。空闲的后台 slot 最多保留 5 个（`MAX_IDLE_BACKGROUND_SLOTS`），运行中或等待回答的从不释放；已释放的 slot 再请求会返回 410，前端自动重新打开。

### 运行控制

Agent 正在运行时，Composer 上有明确的三种选择，直接映射 MyHarness 真实的机制：

| 选择 | 行为 | 底层 |
| --- | --- | --- |
| **Steer**（Enter） | 在当前运行的下一个模型步骤前送达，不会打断正在执行的工具 | `AgentSession.prompt(..., { streamingBehavior: "steer" })` |
| **Queue**（Alt+Enter） | 等当前运行完全结束后再送达 | `streamingBehavior: "followUp"` |
| **Interrupt** | 立即中止当前运行，然后发送新消息 | `AgentSession.abort()` → `waitForIdle()` → `prompt()` |
| **Stop**（按钮 / 输入框为空时 Esc） | 中止当前运行 | `AgentSession.abort()` |

排队中的消息显示在 Composer 上方，可一键放回输入框。

### 状态语义

“轮次结束”不等于“任务成功”。摘要与横幅使用明确的状态：`Completed`、`Partially completed`（失败/超时但已改动文件）、`Failed`、`Cancelled`、`Waiting for you`。运行中的状态来自 `RunStateSnapshot`；结束后的状态来自 `run_state_changed` 的终态；历史消息（没有运行记录）按最后一条 assistant message 的 `stopReason` 推导，并且只声明能证明的事实（例如“No file edits were recorded”而不是“没有改文件”）。

### 审批与用户问题

MyHarness 核心没有内置的工具权限系统；审批来自 Extension 通过 `ctx.ui.select/confirm/input/editor` 提出的问题（例如 `examples/extensions/permission-gate.ts`）。Web UI 实现了同一套 `ExtensionUIContext` 对话方法（`mode: "web"`）：问题显示在 Composer 上方的醒目操作条里，不是 Modal，头部同时显示 `Waiting for you`；有 timeout 的对话会倒计时。Project Trust 问题（启动或切换到其他项目时）在浏览器里回答。

## 与 CLI 的关系

* Web 服务里每个打开的 Chat 各有一个 `AgentSession`（TUI 一次只有一个），可同时运行；每个都走与 TUI 相同的完成阶段与 Git checkpoint。切换 Chat 不会中断运行中的任务。
* 完成阶段沿用 TUI 的同一批函数：`collectFinalWorkspaceChanges`、Git checkpoint 的 complete / retain、Auto Memory 提取、`agent_response_ready` 事件。
* Git：`/commit`（`GitCommitUseCase`）、`/push`（`GitPushUseCase`）、`/restore`（`discardChangesToHead`）、`/undo`（`restoreGitCheckpoint`）、Worktree（`GitWorktreeUseCase`）、本地仓库登记（`LocalGitRepositoryStore`）都调用现有用例，没有新的 Git 逻辑。
* Settings 通过 `SettingsManager` 写入同一份 `settings.json`；Provider 凭据通过 `ModelRuntime` 写入同一份 `auth.json`。浏览器只会看到密钥的后四位。

与 TUI 的已知差异（有意为之，见 [维护](#维护)）：

* `/commit` 失败时不会自动进入 Agent 修复循环，而是显示 Git 输出并提供 “Ask the agent to fix it”；`/push` 的 CI 失败同理，提供 “Ask the agent to fix CI”。
* 最终回复不会因 Auto Memory 整理而被延迟显示。
* TUI 专用的 Extension 能力（`custom()` 组件、自定义 editor/footer/header）在 Web 中无效；`setStatus`、`setWidget`（字符串数组）、`setWorkingMessage`、`setTitle`、`notify` 与对话方法有效。
* MyHarness 没有持久 PTY，所以 Terminal 面板是命令历史与直接命令，不是交互式终端。
* “这一轮改了什么”的数据只在本次服务进程里记录（最近 12 轮）；重启后历史 Chat 仍能看到步骤，但 Changes → This task 不含旧任务。`Working tree` 范围永远读取真实的 Git 状态。

## 安全

* 只绑定 `127.0.0.1`；校验 `Host`（防 DNS rebinding）、`Sec-Fetch-Site`、`Origin`；所有写请求必须带 `x-myharness-web: 1`；响应带严格 CSP（仅同源脚本，无内联脚本）。
* 文件 API 只读，路径解析后必须落在当前 Workspace 内（含符号链接检查）；文件夹选择器只列子目录名。
* 模型输出的 Markdown 不渲染原始 HTML，链接协议白名单，远程图片被 CSP 阻止。
* `models.json` 中的字面量 key / header 在浏览器里显示为占位符，保存时未改动则保留原值。

## 实现地图

```text
packages/coding-agent/
├── src/modes/web/                 服务端（TypeScript，随 CLI 一起构建）
│   ├── web-mode.ts                启动 / 关闭；startWebBootstrap（先起 HTTP 以便回答 Project Trust）
│   ├── http-server.ts             loopback HTTP、路由、静态文件、SSE
│   ├── hub.ts                     WebHostHub：每个打开的会话一个 WebHost（slot），并发运行与请求路由
│   ├── host.ts                    WebHost：订阅 AgentSession 事件、完成阶段、快照、prompt 提交
│   ├── dialogs.ts                 Extension UI 对话桥（ExtensionUIContext 的 Web 实现）
│   ├── changes.ts                 ChangeTracker：edit/write 快照 + checkpoint → 逐文件 diff
│   ├── wire.ts                    AgentMessage / SessionEntry → JSON wire items
│   └── routes-*.ts                core / sessions / files / git / settings / providers
└── web/                           前端（原生 ES modules，无构建步骤）
    ├── index.html  css/  vendor/  Preact + htm；marked / highlight.js 复用 HTML 导出的 vendor 文件
    └── js/                        store.js（状态+SSE，按 slot 分状态）、turns.js（对话模型）、transcript.js、composer.js、
                                   command-panel.js（行内命令面板）、context-usage.js（上下文用量）、folder-picker.js、
                                   i18n.js / lang.js / locales/（界面语言）、panel-*.js、overlays-*.js、sidebar.js、app.js …
```

数据流：浏览器 → `POST /api/...`（命令）；服务端 → `GET /api/events`（SSE：`message_*`、`tool_*`、`run_state`、`run_finished`、`queue_update`、`dialogs`、`session_replaced` 等）。客户端 `store.js` 用 `/api/state` 与 `/api/transcript` 做快照，断线重连后重新拉取。静态资源目录由 `getWebUiDir()`（`config.ts`）解析，源码、dist、Bun binary 三种布局都指向包根/可执行文件旁的 `web/`。

## 维护

* 前端没有构建步骤；改 `web/` 下的文件后刷新页面即可。新增第三方前端库必须放进 `web/vendor/` 并更新 `THIRD_PARTY_NOTICES.md`。
* 新增 API：在对应 `routes-*.ts` 里注册，调用现有领域模块；不要在路由里复制业务规则。新增 SSE 事件：在 `host.ts` 转发，在 `web/js/store.js` 消费。
* wire 格式（`wire.ts`）只投影现有数据，不发明字段；前端不要伪造后端没有返回的状态。
* 对话模型的纯逻辑（`turns.js`、`diff-parse.js`、`util.js`）、界面语言（`test/web-i18n.test.ts`）和上下文构成（`test/web-context-breakdown.test.ts`）有单元测试；`ExtensionMode` 现在包含 `"web"`，新增基于 mode 的 Extension 分支时要一并考虑。
* Web 偏好（主题、宽度、面板状态）存在浏览器 `localStorage`（按 origin，即端口区分）；它们不进入 `settings.json`。

## 验证

```powershell
npm.cmd --workspace @myharness/coding-agent test -- test/web-http-server.test.ts test/web-wire-changes-dialogs.test.ts test/web-frontend-logic.test.ts test/web-host.test.ts test/web-i18n.test.ts test/web-context-breakdown.test.ts
```

`web-host.test.ts` 使用真实的 `AgentSessionRuntime`（faux provider）通过 HTTP/SSE 走完整链路：prompt → 工具 → run_finished → Changes/diff → Files → Settings → Sessions → 直接 shell。真实 Provider、浏览器渲染和 Windows 桌面行为需要单独运行验证。
