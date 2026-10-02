# tools/ — 内置工具

## 说明

### 职责

模型能调用的内置工具都在这里：每个工具的参数 schema、执行、结果结构，以及（单独放的）终端展示。工具的执行不依赖任何界面。

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
| `sub-agent.ts` | `agent` 工具：启动只读的 Explore 子进程（前台或后台批次），收集结果、超时与停滞检测；`runExploreBatch()` 也被 `workflow/` 使用 |
| `symbols.ts` | `symbols` 工具：符号、定义、引用、诊断等查询 |
| `symbols-runtime.ts` | `symbols` 工具需要的运行时端口：索引、路由、安装状态 |
| `render-utils.ts` | 旧路径的兼容 re-export（实际在 `presentation/render-utils.ts`） |

### contracts/

`index.ts`：把 `extensions/contracts/tool.ts` 的 `ToolDefinition` 以 `BusinessToolDefinition` 名称导出。内置工具和扩展工具用同一个执行契约。

### files/ — 文件工具

`read.ts`、`write.ts`、`edit.ts`、`grep.ts`、`find.ts`、`ls.ts`，每个文件一个工具（schema + 执行 + 可替换的 `*Operations`）。另有：

- `edit-diff.ts`：编辑的匹配、换行符保持、diff 生成；
- `file-mutation-queue.ts`：同一文件的写操作排队；
- `mutation-result.ts`：取消到达时文件其实已写入的情况标记。

### shell/ — Shell 工具

| 文件 | 内容 |
| --- | --- |
| `bash.ts` | `bash` 工具和本地执行实现 `createLocalBashOperations()` |
| `pwsh.ts` | `pwsh` 工具（Windows PowerShell） |
| `executor.ts` | `executeBashWithOperations()`：用户直接执行命令（`!命令`）时用的流式执行 |
| `session-bash.ts` | `SessionBashRunner`：一个会话里用户直接执行的命令。同一时间只跑一条，完整输出落盘，结果写入会话；Agent 正在运行时先排队，等本轮结束再写入 |
| `read-only-guard.ts` | 子 Agent 的只读 Bash 守卫：拒绝列表 + 只读允许列表 + 可选的模型裁决 |

### github/

`tool.ts`：`github` 工具，使用已连接的 GitHub 账号（`providers/credentials/account-connections.ts`）调用 GitHub API。

### web-search/ — 联网搜索与读网页

可选能力，默认引擎是 Google 和 Bing，不依赖外部搜索服务。

| 路径 | 内容 |
| --- | --- |
| `tool.ts` | `web_search` / `web_fetch` 的 schema 与结果格式 |
| `service.ts` | `WebSearchService`：多查询 × 多引擎、合并去重排序、下载上限、缓存、引擎测试 |
| `engine-runner.ts` | 先走 HTTP，被拦截时按规则切到浏览器；引擎冷却 |
| `engines/` | 各引擎的请求与结果解析：`google.ts`、`bing.ts`、`duckduckgo.ts`、`brave.ts`、`brave-api.ts`；`index.ts` 是引擎表 |
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

### presentation/ — 终端展示

每个内置工具一个渲染器（`bash.ts`、`edit.ts`、`read.ts` …），`index.ts` 的 `getBuiltinToolRenderer()` 按名字取渲染器，`public.ts` 把“执行契约 + 渲染器”合成对外公开的工具定义，`render-utils.ts` 是共用的展示小工具。

### 对外接口

`src/index.ts` 导出 `tools/registry.ts`、`tools/contracts`、`tools/presentation/public.ts`、`tools/files/edit-diff.ts`。

### 依赖

- 依赖：`system-prompts/loader`（工具说明文案）、`utils`、`symbols/*`（`symbols` 工具）、`workflow`（登记）、`agent/delegation`、`agent/runtime`（`role.ts`、`messages.ts`）、`extensions`（`session-tool-registry.ts` 用 runner、wrapper 和工具类型）、`observability/runtime-trace.ts`、`providers/credentials`（GitHub 连接）、`session/manager`（结果落盘位置）、`config/settings`（Web Search 设置）；`presentation/` 额外依赖 `modes/interactive` 的主题与组件、`@myharness/tui`。
- 被依赖：`agent/runtime`、`extensions`、`workflow`、`modes/*`、`exports/html`、`symbols/runtime`、`context`。

## 维护

- 新增工具：写执行文件（放到合适的子目录）→ 在 `registry.ts` 登记名字和工厂 → 在 `presentation/` 加渲染器 → 在根目录 `system-prompts/tools/<名字>/` 加提示片段。
- 执行文件不能导入 `presentation/`、`modes/interactive` 或 `@myharness/tui`。
- 工具名、参数名、结果的 `details` 结构会被写进 Session 并被界面和导出解析，不要随意改；确需改动时用 `prepareArguments` 兼容旧输入。
- Shell 执行、输出截断、结果落盘各只有一份实现，新工具复用它们。
- Web Search 的搜索规划（搜什么、读哪些页）由 Agent 决定；工具只负责并发、缓存、取消、超时和逐项诊断。任何下载都必须先过 `url.ts` 的检查。
- 相关测试：`tools.test.ts`、`tool-result-persistence.test.ts`、`bash-executor.test.ts`、`read-only-bash-guard*.test.ts`、`file-mutation-queue.test.ts`、`sub-agent.test.ts`、`symbols-tool-*.test.ts`、`github-tool.test.ts`、`web-search*.test.ts`、`web-fetch-documents.test.ts`、`tool-execution-*.test.ts`。
