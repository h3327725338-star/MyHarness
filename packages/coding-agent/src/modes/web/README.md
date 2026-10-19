# modes/web/ — Web UI 服务端

## 说明

### 职责

`--web` 模式的服务端：只绑定本机回环地址的 HTTP + SSE 服务，把同一个 `AgentSessionRuntime` 投影给浏览器。它不实现 Agent、Session、Git、Provider 的规则，只做传输和展示数据的转换。

浏览器前端在包根的 `web/`（原生 ES modules，无构建步骤），不在 `src/` 里。

完整的界面说明、文件地图、数据流、前端维护规则和验证命令见 [docs/web-ui.md](../../../docs/web-ui.md)；本文件只说明目录边界。

### 文件

| 文件 | 内容 |
| --- | --- |
| `web-mode.ts` | 启动与关闭；`startWebBootstrap()` 先起 HTTP 服务（这样 Project Trust 可以在浏览器里回答），`runWebMode()` 在 runtime 创建后接管 |
| `http-server.ts` | `WebHttpServer`：回环绑定、来源检查、JSON 路由、静态文件、SSE |
| `hub.ts` | `WebHostHub`：每个打开的会话一个 `WebHost`（slot），多个会话可同时运行 |
| `host.ts` | `WebHost`：订阅 `AgentSession` 事件并转发给浏览器，运行任务结束后的收尾，提供快照与 prompt 提交 |
| `lifecycle.ts` | `WebLifecycle`：最后一个页面断开后按宽限时间退出服务 |
| `dialogs.ts` | 扩展 UI 对话框（选择、确认、输入、编辑）到浏览器的桥 |
| `changes.ts` | `ChangeTracker`：把检查点、基线和 edit/write 快照变成逐文件 diff |
| `wire.ts` | 运行时数据（消息、会话条目、模型）到 JSON 的投影 |
| `generation-speed.ts`、`request-cache.ts` | 输出速度和每次请求的缓存命中率，只用 Provider 报告的真实数据 |
| `terminal.ts` | Terminal 面板的真实 Shell（伪终端） |
| `folder-dialog.ts` | 调用系统的文件夹选择窗口 |
| `routes-core.ts`、`routes-sessions.ts`、`routes-files.ts`、`routes-git.ts`、`routes-settings.ts`、`routes-providers.ts`、`routes-accounts.ts`、`routes-terminal.ts`、`routes-modes.ts` | 各组 API 路由 |
| `session-changes.ts` | 从会话条目收集文件差异（供变更展示用） |
| `session-ownership.ts` | 未提交文件归哪个对话：最新一次改动说了算（谁最后改的谁提交） |
| `change-claims.ts`、`changes-stats.ts` | 变更认领登记与 worktree 变更统计/列表缓存（numstat 解析、行数与二进制判断） |
| `file-pages.ts`、`local-files.ts`、`office.ts`、`html-preview.ts` | 文件内容服务：分页读取、本地文件、Office 文档、HTML 预览 |
| `slot-budget.ts`、`transcript-cache.ts`、`web-prefs.ts`、`worktree-launch.ts` | 会话 slot 预算、转录缓存、Web 偏好、worktree 启动 |
| `index.ts` | 出口 |

### 依赖

- 依赖：`agent/runtime`、`application`（用例、WorkspaceStore）、`startup`（命令表、设置菜单）、`config`、`context`（用量明细）、`extensions`（UI 契约）、`git/*`（检查点、用例、工作区变更）、`providers/*`、`session/*`、`skills/loader`、`utils`；可选依赖 `@lydell/node-pty`（终端）。
- 被依赖：`src/index.ts`（公共出口）与 `web.ts` 启动入口。

## 维护

- 新增 API：在对应的 `routes-*.ts` 注册并调用现有领域模块或用例，不在路由里复制业务规则。
- 路由里不要调用同步的 Git 或子进程：服务只有一个事件循环，一次同步调用会卡住所有请求。
- `wire.ts` 只投影已有数据，不发明字段；前端不伪造后端没有返回的状态。
- 新增 SSE 事件：在 `host.ts` 转发，在 `web/js/store.js` 消费。
- 服务只接受回环连接并检查请求来源；凭证不离开服务端，浏览器只拿到标签和末四位。改 `http-server.ts` 或 Provider 路由时保持这些限制。
- `host.ts` 是唯一的会话宿主：任务收尾（变更检测、检查点结算、Auto Memory）只在这里与 `AgentSession` 衔接，改收尾语义时同时检查 `AgentSession` 的事件顺序（`agent_end` → 收尾 → `agent_settled`）与扩展事件。
- 相关测试：`web-*.test.ts`（HTTP 安全、wire/changes/dialogs、前端纯逻辑、真实 runtime 的 HTTP/SSE 集成、终端、生命周期）。浏览器里的渲染与交互需要实际运行验证。
