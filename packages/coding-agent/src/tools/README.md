# tools/ — 内置工具

## 说明

### 职责

模型能调用的内置工具都在这里：每个工具的参数 schema、执行、结果结构。工具的执行不依赖任何界面；对外公开的工具定义见 `presentation/public.ts`。

### 顶层文件

| 文件 | 内容 |
| --- | --- |
| `registry.ts` | 全部内置工具的名字 `allToolNames` 和工厂：`createAllToolDefinitions()`、`createTool()` 等；也是各工具类型的统一出口 |
| `session-tool-registry.ts` | `SessionToolRegistry`：一个会话的工具注册表。把内置工具、SDK 自定义工具和扩展工具装配成可执行的工具表，套上结果落盘，应用允许/排除名单，决定启动时和设置变化后哪些工具启用，并给出工具对系统提示的贡献 |
| `tool-definition-wrapper.ts` | `ToolDefinition`（执行契约）与 Agent Core 的 `AgentTool` 互相转换 |
| `tool-result-persistence.ts` | 过长的工具输出落盘到会话目录的 `tool-results/`，模型只看到截断文本和文件路径；孤儿文件清理 |
| `truncate.ts` | 按行数和字节数截断输出 |
| `output-accumulator.ts` | 流式输出累积，内存有上限 |
| `path-utils.ts` | 工具参数里的路径展开与解析 |
| `sub-agent.ts` | `agent` 工具：启动只读或读写的 Explore 子进程（前台或后台批次）；非 Git 工作区先装配过滤后的独立文件镜像，失败不回宿主运行，逐任务 finally 清理（机制见 `agent/delegation/non-git-sandbox.ts`），通过 NDJSON stdin 下发任务与“收敛提醒” steering 消息，收集结果、超时与停滞检测；只有 stall watchdog、墙钟超时、`maxTurns` 和取消会真正终止任务，重复操作/连续工具失败/无新信息只注入提醒；带 `questions` 的任务要求逐项回答并附 `## Completion checklist`，缺失即记为 `partial`（`stopReason: "incomplete_answer"`）；`runExploreBatch()` 也被 `workflow/` 使用 |
| `symbols.ts` | `symbols` 工具：符号、定义、引用、诊断等查询，以及 find_existing / read_symbol / impact / rename_preview 组合操作（实现在 `symbols/workflow/`） |
| `apply-rename.ts` | `apply_rename` 工具：按 rename_preview 的计划写入；与 `symbols` 同受 `codeIntelligence.symbolsEnabled` 控制，复用 apply_patch 的文件队列与整体回滚，任一文件哈希变化则整份拒绝 |
| `workspace.ts` | `workspace` 工具（仅桌面端）：内置浏览器与右侧工作区的结构化控制。浏览器命令经服务进程到 Electron 主进程的 IPC 通道操作 `WebContentsView`（含导航、DOM/可访问性/交互元素、点击/输入/滚动、页内查找、工作区文件上传、截图、下载取消/重试、网络与站点权限状态），工作区命令转发给页面（页面拥有标签列表和媒体元素）并以其回报的状态为准；只在 `MYHARNESS_DESKTOP_HOST=1` 且 IPC 已连接时注册。站点权限只能由页面里的用户决定，工具不能授予。 |
| `symbols-runtime.ts` | `symbols` 工具需要的运行时端口：索引、路由、安装状态 |

### contracts/

`index.ts`：把 `extensions/contracts/tool.ts` 的 `ToolDefinition` 以 `BusinessToolDefinition` 名称导出。内置工具和扩展工具用同一个执行契约。

### files/ — 文件工具

`read.ts`、`write.ts`、`edit.ts`、`grep.ts`、`find.ts`、`ls.ts`，每个文件一个工具（schema + 执行 + 可替换的 `*Operations`）。另有：

- `extraction-cache.ts`：富文件结果的会话→工作区→Data 全局缓存，按原路径、mtime、size 与图像选项失效；不在原文件旁生成缓存。
- `spreadsheet-preview.ts`：CSV/XLSX/ODS 的工作表概览和 Markdown 表格，每表最多 100 行、30 列、每格 500 字符。
- `legacy-office.ts`：有界的 CFB 容器与 PPT 文本记录读取。当前是基础正文抽取，不支持完整的 PPT 修订链/逻辑页序，也尚未实现旧 DOC/XLS 正文解析；不能宣称旧 Office 已全量支持。
- `read.ts` 的富文件解析异常返回成功工具结果中的诊断文字；取消、无效参数、路径访问失败仍保留既有错误语义。小于输出阈值的完整纯文本读取保留 BOM、CRLF 与末尾换行；分页/截断仍沿用原有按行预览。
- `edit-diff.ts`：编辑的匹配、换行符保持、diff 生成；
- `file-mutation-queue.ts`：同一文件的写操作排队；
- `mutation-result.ts`：取消到达时文件其实已写入的情况标记；
- `read-state.ts`：记录文件读取状态（修改时间与大小），在 `edit`/`write` 修改已存在文件前执行“先读后改”与过期检测（按 Session 隔离、LRU 上限 1000）。
- `apply-patch.ts`：`apply_patch` 工具，一次补丁原子地增、删、改、移动多个文件。先在内存里算出全部结果，任何一处对不上都不写盘；写盘失败时回滚已写入的文件。这是可选工具，不在默认工具集合中，`agent` 子智能体的角色白名单也不包含它。
- `apply-patch-parser.ts`：补丁格式的纯解析，不读写磁盘。

### shell/ — Shell 工具

| 文件 | 内容 |
| --- | --- |
| `bash.ts` | `bash` 工具和本地执行实现 `createLocalBashOperations()` |
| `pwsh.ts` | `pwsh` 工具（Windows PowerShell） |
| `executor.ts` | `executeBashWithOperations()`：用户直接执行命令（`!命令`）时用的流式执行 |
| `session-bash.ts` | `SessionBashRunner`：一个会话里用户直接执行的命令。同一时间只跑一条，完整输出落盘，结果写入会话；Agent 正在运行时先排队，等本轮结束再写入 |
| `job-manager.ts` | `BackgroundJobManager`：后台 shell 任务表、日志写临时文件、增量字节游标读取、进程树终止、单任务日志上限（64MB）、会话并发上限（8 个）、最近 100 个任务淘汰并清理对应日志文件 |
| `job-tools.ts` | `job_list`、`job_output`、`job_kill` 三个内置工具的定义与创建 |
| `session-scope.ts` | 会话所有权作用域解析：优先读取 `ctx.sessionManager.getSessionId()`，退回 cwd，隔离不同会话的任务和状态 |
| `shell-session.ts` | `preserve_state` 状态保持机制：尾部探针构建、探针解析与输出剥离、环境变量差分、跨进程调用状态注入 |
| `delegated-write-guard.ts` | 读写型子智能体的落笔边界：文件/Glob 参数与 shell（可执行文件、内联代码、`cd`、重定向、变量路径）必须留在任务 worktree 内；`agent`/`workflow`/`ultracode` 及同类派发工具一律拦截，标记 `[delegated-write-guard]` |
| `null-redirect-guard.ts` | `findBashNullDeviceRedirect()`：bash 里 `>nul` 会建出真文件并破坏 Git，属引号感知的纯扫描，不执行命令 |
| `read-only-guard.ts` | 子 Agent 的只读 Bash 守卫：按 shell 序列段（管道、`&&`、`;`）逐段用只读允许列表 + 危险选项/拒绝列表判定，诊断重定向（`2>/dev/null`）与临时路径写入不影响判定，可选的模型裁决；拦截结果带 `[read-only-guard]` 标记和具体原因，不计入连续工具失败 |

### memory/ — 记忆工具

`search.ts`：`memory_search`（无 `query` 列记忆目录，有 `query` 用 `agent/runtime/auto-memory.ts` 的 `selectMemoriesForQuery()` 返回摘要）和 `memory_get`（按 id 取全文，未找到只返回说明）。两个工具只读、`executionMode: "parallel"`；读取通过可注入的 `MemoryToolOperations`，`createSessionMemoryOperations()` 按会话的 Data root / Workspace / Conversation 读取，Auto Memory 关闭或会话不持久化时返回“未启用”说明。`write.ts`：`memory_write`（用户明确要求记住、导入、更正或更新时，一次最多 10 条地创建/更新本轮三层的记忆与常驻画像；省略 `id` 新建，只有 `global/用户画像` 允许带 `id` 首次创建；超 10 KB 拒绝而不截断；`executionMode: "sequential"`，经 `session/memory/store.ts` 的锁写盘并刷新索引、记一笔待整理变化）。`manage.ts`：`memory_delete` 彻底删除、`memory_claim` 认领 `pending/`。子智能体按 `agent/runtime/role.ts` 白名单不会拿到这些工具（写入类同样不给）。

### interaction/ — 交互工具

- `ask-user-question.ts`：`ask_user_question`。通过 `ctx.ui.select` / `ctx.ui.input` 向用户提 1–4 个问题并按顺序收集回答：有选项时单选，默认附加“其他（自己输入）”（`allowOther: false` 时去掉）；无选项时自由输入。用户关闭弹窗时不编造答案，停止继续提问，并在结果里告诉模型用户没有回答。没有可交互界面（SDK、子智能体、无头运行）时抛出 `code: "NO_INTERACTIVE_UI"`。
- `todo-write.ts`：`todo_write`。每次传入整张待办清单并整张替换，最多 50 项，最多一项 `in_progress`，内容不能为空或重复。不落盘：清单就在对话记录的工具调用与结果里。

两个工具都是 `executionMode: "sequential"`，只对主智能体默认启用；子智能体白名单（`agent/runtime/role.ts`）不包含它们。

### github/

`tool.ts`：`github` 工具，使用已连接的 GitHub 账号（`providers/credentials/account-connections.ts`）调用 GitHub API。

### web-search/ — 联网搜索与读网页

可选能力，默认引擎是 Google 和 Bing，不依赖外部搜索服务。

| 路径 | 内容 |
| --- | --- |
| `tool.ts` | `web_search` / `web_fetch` 的 schema 与结果格式 |
| `service.ts` | `WebSearchService`：多查询 × 多引擎、合并去重排序、下载上限、缓存、引擎测试 |
| `engine-runner.ts` | 先走 HTTP，被拦截时按规则切到浏览器；引擎冷却 |
| `engines/` | 各引擎的请求与结果解析：`google.ts`、`bing.ts`、`duckduckgo.ts`、`brave.ts`、`tavily.ts`；`index.ts` 是引擎表 |
| `transport.ts` | HTTP 与浏览器两种传输的契约 |
| `http.ts` | 普通 HTTP 请求与解码 |
| `browser/` | 本机浏览器兜底：专用 profile、Firefox（扩展 + 本地桥 + RDP）、Chrome/Edge（CDP）、浏览器选择、Cookie 导入、验证窗口置前 |
| `page.ts` | 下载网页、逐跳检查 URL 与 DNS、HTML 转 Markdown、访问墙识别 |
| `page-browser.ts` | 直接请求被拒时用浏览器读正文 |
| `document.ts` | 文档类链接（PDF、Office）转 Markdown |
| `excerpts.ts` | 从页面中选取与问题相关的片段 |
| `url.ts` | URL 安全策略（防 SSRF：拒绝内网地址）与规范化 |
| `cache.ts` | 会话范围的搜索缓存 |
| `errors.ts`、`types.ts` | 错误与结果类型 |

### presentation/ — 对外公开的工具定义

`public.ts` 只导出执行契约用的工具定义工厂（不含终端渲染器）。各内置工具的终端展示由上层按需组合，不在本目录维护。

### 对外接口

`src/index.ts` 导出 `tools/registry.ts`、`tools/contracts`、`tools/presentation/public.ts`（对外公开的工具定义出口）、`tools/files/edit-diff.ts`。

### 依赖

- 依赖：`system-prompts/loader`（工具说明文案）、`utils`、`symbols/*`（`symbols` 工具）、`agent/runtime/auto-memory.ts`（记忆工具的读取与排序）、`session/memory`（记忆路径）、`workflow`（登记）、`agent/delegation`、`agent/runtime`（`role.ts`、`messages.ts`）、`extensions`（`session-tool-registry.ts` 用 runner、wrapper 和工具类型）、`observability/runtime-trace.ts`、`providers/credentials`（GitHub 连接）、`session/manager`（结果落盘位置）、`config/settings`（Web Search 设置）。
- 被依赖：`agent/runtime`、`extensions`、`workflow`、`modes/web`、`exports/html`、`symbols/runtime`、`context`。

## 维护

- 新增工具：写执行文件（放到合适的子目录）→ 在 `registry.ts` 登记名字和工厂 → 对外公开的定义经 `presentation/public.ts` 转出 → 在仓库根 `system-prompts/common/tools/<名字>/` 加提示片段。
- 执行文件不能导入 `presentation/`（展示出口只转出定义，不被执行文件反向依赖）。
- 工具名、参数名、结果的 `details` 结构会被写进 Session 并被界面和导出解析，不要随意改；确需改动时用 `prepareArguments` 兼容旧输入。
- Shell 执行、输出截断、结果落盘各只有一份实现，新工具复用它们。
- 文件写操作（`edit`、`write`）修改已存在文件时要求“先读后改”，改前校验读取状态与文件是否过期，写后刷新状态；非本地文件系统（自定义 operations）跳过校验。`apply_patch` 的 Update 与 Delete 同样执行这一检查（它只使用本地文件系统）。
- Web Search 的搜索规划（搜什么、读哪些页）由 Agent 决定；工具只负责并发、缓存、取消、超时和逐项诊断。任何下载都必须先过 `url.ts` 的检查。
- 相关测试：`tools.test.ts`、`read-state.test.ts`、`tool-result-persistence.test.ts`、`bash-executor.test.ts`、`read-only-bash-guard*.test.ts`、`file-mutation-queue.test.ts`、`sub-agent.test.ts`、`symbols-tool-*.test.ts`、`github-tool.test.ts`、`memory-intelligence.test.ts`、`web-search*.test.ts`、`web-fetch-documents.test.ts`、`tool-execution-*.test.ts`、`ask-user-and-todo-tools.test.ts`。
