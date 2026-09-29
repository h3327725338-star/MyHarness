# Web UI

MyHarness 有两个同等的正式入口：终端里的 TUI，以及只在本机使用的浏览器 Web UI。两者共用同一个 `AgentSessionRuntime` / `AgentSession`、同一套 Session、Settings、Provider、Tool、Git checkpoint 和 Extension，没有第二套 Agent 逻辑。Web UI 是现有能力的另一个交互层，不是对 CLI 的重写。

## 启动

```powershell
# 源码 checkout（Windows）
.\dev.cmd --web
# 或直接双击仓库根目录的 dev-web.cmd（等价于 dev.cmd --web，额外参数会转发）
# 或已构建的 CLI
myharness --web
```

| 参数 | 说明 |
| --- | --- |
| `--web` | 启动本地 Web UI，而不是 TUI。不能与 `--print`、`--mode`、`--list-models` 同时使用。 |
| `--port <n>` | 端口，默认 `7878`；被占用时依次尝试后面的 10 个端口；`0` 表示由系统分配。 |
| `--no-open` | 不自动打开默认浏览器（终端会打印 `MyHarness Web UI: http://127.0.0.1:<port>/`）。 |

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

* **侧栏**：真实的 Workspace / Chat 结构（`WorkspaceStore` + `SessionManager.list`）。新建 Chat、切换 Chat、重命名（手动或 AI 生成标题）、删除、添加/移除 Workspace（带文件夹选择器）。行内状态槽位固定，运行中/等待/失败不会挤动标题。
* **对话**：用户消息、运行摘要、最终回复。默认不展开 Thinking、读文件、搜索、命令和编辑，只显示一行摘要，例如 `Worked for 32s · 9 actions · 4 files changed`。
  * 第一层：摘要行（`Worked for …` / `Failed after …` / `Partially completed` / `Cancelled after …` / 运行中显示当前动作）。
  * 第二层：点开后是可读步骤。读文件、搜索、命令、编辑等用自然语言描述，连续同类动作聚合（“Read 8 files”），可继续展开单项；Thinking 有内容时可展开；sub-agent / workflow 显示阶段与任务进度。
  * 第三层：单项的 Raw details——真实 tool name、arguments、stdout/stderr、exit code、耗时、result details。
  * 需要用户处理的状态永远不折叠：等待回答/审批、失败、部分完成、取消都有独立的横幅，横幅会说明失败原因、改了几个文件、跑了几条命令，并提供 View changes / Retry。
* **Composer**：一个输入卡。模型选择（Provider 分组、搜索、刷新 catalog）、推理力度、上下文用量环、附件（图片：粘贴/拖放/选择）、`/` 命令与 skills、`@` 文件提及、`!cmd` / `!!cmd` 直接运行 shell、历史消息（↑/↓）。发送与停止在同一个位置切换。
* **详情面板**：
  * **Changes**：这一轮到底改了什么。文件列表 + 真实的 unified / side-by-side diff；`This task` 与 `Working tree`（Git 未提交改动）两个范围；Git 操作条（Commit… / Push… / Undo task… / 更多）。
  * **Files**：只读的工作区文件树（带 Git 状态与“本轮改动”标记）、文件名搜索、文件查看（语法高亮、图片预览、跳转到行）、`@` 提及到 prompt。
  * **Terminal**：本 Session 的每一条 shell 命令（Agent 的 `bash`/`pwsh` 工具和你自己的 `!` 命令）：命令、cwd、状态、耗时、exit code、真实输出（保留 ANSI 颜色）、截断与完整输出路径；底部可直接运行新的命令。
  * **Session**：上下文用量与压缩、Session 统计、Git checkpoint、分支树（导航 / fork）、Tools（可开关）、Skills、Prompt templates、Extensions、项目上下文文件、Reload resources。
* **设置**（`Ctrl+,`）：外观（主题/密度/动画/阅读宽度/浏览器通知，保存在浏览器）；Agent、Assistants（Auto Memory / Sub-agent / Vision）、Tools（Web search、Code Intelligence）、Network、Shell、Safety（Project Trust、默认信任策略）；Providers（启停、API Key 多密钥管理、OAuth 登录、`models.json` 自定义 Provider）。
* **命令面板**（`Ctrl+K`）：动作、Chat、文件的统一搜索。

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

* 同一进程只有一个活动 `AgentSession`（与 TUI 相同）。侧栏里其他 Chat 只能在当前任务空闲时切换；运行中切换会被拒绝并提示。
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
│   ├── host.ts                    WebHost：订阅 AgentSession 事件、完成阶段、快照、prompt 提交
│   ├── dialogs.ts                 Extension UI 对话桥（ExtensionUIContext 的 Web 实现）
│   ├── changes.ts                 ChangeTracker：edit/write 快照 + checkpoint → 逐文件 diff
│   ├── wire.ts                    AgentMessage / SessionEntry → JSON wire items
│   └── routes-*.ts                core / sessions / files / git / settings / providers
└── web/                           前端（原生 ES modules，无构建步骤）
    ├── index.html  css/  vendor/  Preact + htm；marked / highlight.js 复用 HTML 导出的 vendor 文件
    └── js/                        store.js（状态+SSE）、turns.js（对话模型）、transcript.js、composer.js、
                                   panel-*.js、overlays-*.js、sidebar.js、app.js …
```

数据流：浏览器 → `POST /api/...`（命令）；服务端 → `GET /api/events`（SSE：`message_*`、`tool_*`、`run_state`、`run_finished`、`queue_update`、`dialogs`、`session_replaced` 等）。客户端 `store.js` 用 `/api/state` 与 `/api/transcript` 做快照，断线重连后重新拉取。静态资源目录由 `getWebUiDir()`（`config.ts`）解析，源码、dist、Bun binary 三种布局都指向包根/可执行文件旁的 `web/`。

## 维护

* 前端没有构建步骤；改 `web/` 下的文件后刷新页面即可。新增第三方前端库必须放进 `web/vendor/` 并更新 `THIRD_PARTY_NOTICES.md`。
* 新增 API：在对应 `routes-*.ts` 里注册，调用现有领域模块；不要在路由里复制业务规则。新增 SSE 事件：在 `host.ts` 转发，在 `web/js/store.js` 消费。
* wire 格式（`wire.ts`）只投影现有数据，不发明字段；前端不要伪造后端没有返回的状态。
* 对话模型的纯逻辑（`turns.js`、`diff-parse.js`、`util.js`）有单元测试；`ExtensionMode` 现在包含 `"web"`，新增基于 mode 的 Extension 分支时要一并考虑。
* Web 偏好（主题、宽度、面板状态）存在浏览器 `localStorage`（按 origin，即端口区分）；它们不进入 `settings.json`。

## 验证

```powershell
npm.cmd --workspace @myharness/coding-agent test -- test/web-http-server.test.ts test/web-wire-changes-dialogs.test.ts test/web-frontend-logic.test.ts test/web-host.test.ts
```

`web-host.test.ts` 使用真实的 `AgentSessionRuntime`（faux provider）通过 HTTP/SSE 走完整链路：prompt → 工具 → run_finished → Changes/diff → Files → Settings → Sessions → 直接 shell。真实 Provider、浏览器渲染和 Windows 桌面行为需要单独运行验证。
