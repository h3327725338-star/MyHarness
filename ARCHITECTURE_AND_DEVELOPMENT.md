# MyHarness 项目架构与开发维护手册

> 本文描述当前 C:\myharness checkout 中已经存在的工程事实，并提供与这些事实相匹配的长期开发规则。它不是重构方案，也不是 Phase 记录。若本文与源码、package.json 或测试配置冲突，应先以当前源码和配置为准，再修正文档。

> 项目阶段：Early-stage / Work in Progress。项目自身使用 Apache-2.0；继承代码和第三方组件继续使用各自的许可证与 attribution，见 `LICENSE`、`NOTICE` 和 `THIRD_PARTY_NOTICES.md`。

## 如何阅读本文

- **当前事实**：由当前源码、目录、Package manifest、脚本或测试直接确认。
- **长期边界**：为了保持现有职责和兼容性的维护规则；它不等于当前所有代码都已经完全满足该规则。
- **未确认**：仅靠静态仓库不能确认，必须通过真实运行时、外部 Provider、当前机器环境或用户配置验证。

文中的路径默认相对于仓库根目录 C:\myharness。涉及用户数据时只描述文件名和格式，不记录真实 credential、Token、Session 内容或个人路径。

## Agent 项目规则入口

修改 MyHarness 的 Agent 先读取根 `AGENTS.md`，再由
`DOCUMENTATION_INDEX.md` 路由到当前任务的专题文档；随后必须回到真实源码、
调用方、配置和测试确认当前实现。这个入口设计避免建立第二套项目规则系统，
也不要求每次任务遍历整个仓库的 Markdown。

根 `AGENTS.md` 是本仓库的开发规则和维护路由器。根目录
`system-prompts/` 则是 MyHarness 产品运行时、面向所有用户项目的静态 System
Prompt 资源；仓库自己的 CI、维护流程和开发细节不应写入其中。产品从本仓库根
或子目录启动时，`AGENTS.md`/`CLAUDE.md` 会由 project context loader 作为项目
上下文加载；这解释运行时行为，但不改变根 `AGENTS.md` 作为仓库开发入口的职责。

## CI baseline 与用户平台边界

`.github/workflows/ci.yml` 是正式 CI baseline，固定使用 GitHub-hosted Windows
x64 runner `windows-2022` 和 `windows-2025` 的 matrix。两个 job 每次正常触发
都执行相同的安装、release/privacy audit、`ffmpeg-static` rebuild、build、check、
搜索工具安装和 test 流程；两者必须全部通过。`windows-latest` 不属于该 baseline。

CI baseline 只描述 GitHub 自动化构建/测试环境。MyHarness 的用户平台是 Windows
桌面 x64；不能把 CI 的 Windows Server label 写成“只支持 Windows Server”，也
不能把这两个 runner 的通过结果扩大解释为已经逐一验证 Windows 10/11 的每个
桌面版本。其他 release、audit 或协作 workflow 的 runner 是各自自动化的范围，
不改变这两个 Windows runner 构成的正式 CI baseline。

## 1. 项目整体概览

MyHarness 是一个 npm workspace monorepo。它由五个主要 Package 组成：产品层 coding-agent、底层 Agent Core agent、模型和 Provider API 层 ai、终端 UI 层 tui，以及独立的 Node SQLite 存储后端 storage/sqlite-node。

主要技术事实：

- 主要源码语言是 TypeScript，Package 使用 ESM。
- 根目录使用 npm workspaces 和 package-lock.json，没有发现 Bun lockfile。
- Node 要求在根目录 package.json 中为 >=22.19.0。
- TypeScript 构建使用 tsgo；测试使用 Vitest 和 Node built-in test runner；静态检查使用 Biome。
- Windows 开发入口是 dev.cmd/dev.ps1。dev.ps1 默认用 `node --import scripts/dev-fast-loader.mjs` 以 Node 原生类型剥离直接运行源码 CLI（比 tsx 快约 10 秒）；设置 `MYHARNESS_DEV_LOADER=tsx` 或传 `--no-env` 时回到 myharness-test.ps1 通过 tsx.cmd 启动。
- 构建后的 CLI 是 packages/coding-agent/dist/cli.js，npm bin 名称是 myharness。
- Bun 主要出现在 binary 构建、Bun 专用入口和部分 profile 路径中；当前没有独立的 Windows Package 或 Bun Package。
- 当前没有独立的 frontend/、core/、shared/ 或 application/bootstrap/ 源码目录。

### Package 职责

| Package | 负责什么 | 当前不负责什么 | Public entry | 主要依赖 |
| --- | --- | --- | --- | --- |
| packages/agent | Provider 无关的 Agent、Agent Loop、消息、Tool 执行队列、通用 Session 和 Harness 抽象 | 不负责 MyHarness CLI、TUI 页面、项目 Settings、产品 Provider catalog | packages/agent/src/index.ts；package 还暴露 ./node | packages/ai |
| packages/ai | Provider、Model、AI API adapter、Auth/OAuth、streaming 和 usage 类型 | 不负责 MyHarness Session JSONL、Git、TUI、项目 Trust | packages/ai/src/index.ts 及 package.json 中声明的 subpath | 各 Provider SDK、Node/HTTP 能力 |
| packages/coding-agent | MyHarness 产品编排、CLI、AgentSession、Session、Context、Tools、Git、Extensions、Provider Runtime、TUI mode | 不承担底层 Agent Loop 的全部实现；不直接把所有存储统一成 SQLite | packages/coding-agent/src/index.ts；CLI 为 src/cli.ts | agent、ai、tui |
| packages/tui | 终端渲染、输入、布局、组件、焦点和主题基础能力 | 不负责 Agent 状态、Provider 请求、Session persistence 或 Git workflow | packages/tui/src/index.ts | marked、get-east-asian-width |
| packages/storage/sqlite-node | 通用 Agent Session/Storage 抽象的 Node node:sqlite backend 和 migration | 当前 coding-agent manifest/source 未确认直接使用它作为 CLI Session backend | packages/storage/sqlite-node/src/index.ts | agent、ai |

Package 级依赖方向是：

~~~text
coding-agent ──→ agent ──→ ai
      └──────────────→ ai
      └──────────────→ tui

storage/sqlite-node ──→ agent、ai
~~~

## 2. 当前整体架构

当前 CLI 的组合根是 packages/coding-agent/src/main.ts。它解析 CLI，创建 Settings、Trust、ResourceLoader、Session Manager、Model Runtime 和 Code Intelligence Runtime，然后创建 AgentSessionRuntime 和 AgentSession，最后选择 Interactive 或 Print mode。

~~~text
CLI / SDK
   │
   ▼
coding-agent/src/cli.ts
   │
   ▼
coding-agent/src/main.ts
实际 composition root
   │
   ├── SettingsManager
   ├── ProjectTrust
   ├── ResourceLoader
   ├── SessionManager
   ├── ModelRuntime
   └── CodeIntelligenceRuntime
           │
           ▼
   AgentSessionRuntime
   Session / Workspace lifecycle
           │
           ▼
   AgentSession
           │
           ├── packages/agent Agent / Agent Loop
           ├── Tools
           ├── Context / Compaction
           ├── Session / Projection / JSONL
           ├── Git / Checkpoint / Worktree
           ├── Provider Runtime / Recovery
           ├── Extensions
           ├── Workflow / UltraCode / Sub-agent
           ├── Symbols / Code Intelligence
           └── Observability
~~~

交互和非交互输出在 Agent Runtime 之后分流：

~~~text
AgentSessionRuntime
   ├── InteractiveMode ──→ coding-agent UI components ──→ packages/tui
   ├── WebMode (--web) ──→ modes/web（loopback HTTP + SSE）──→ 浏览器 packages/coding-agent/web/
   └── PrintMode ────────→ text/json output
~~~

application/ 当前是资源加载、Trust、Workspace 和若干 use case 的协调层。它不是一个名为 bootstrap 的完整启动层；启动对象的组装仍在 main.ts 和 agent/runtime/services.ts 中。

## 3. 根目录和 Package 结构

~~~text
.
├── packages/
│   ├── agent/
│   ├── ai/
│   ├── coding-agent/
│   ├── storage/sqlite-node/
│   └── tui/
├── scripts/
├── system-prompts/
├── docs/decisions/
├── .github/workflows/
├── .husky/
├── package.json
├── PROJECT_STATUS.md
├── LICENSE / NOTICE / THIRD_PARTY_NOTICES.md
├── package-lock.json
├── tsconfig.base.json
├── tsconfig.json
├── biome.json
├── dev.cmd
├── dev-web.cmd
├── dev-web.vbs
├── dev-web.ps1
├── dev.ps1
├── myharness-test.ps1
├── myharness-test.sh
└── test.sh
~~~

### 主要根目录文件

- package.json：workspace、Package 构建顺序、测试、检查、发布、版本和 Node engine。
- package-lock.json：npm 依赖锁定。
- tsconfig.base.json：TypeScript target、module、strict、声明文件和 source map 等基础规则。
- tsconfig.json：workspace include、path mapping、build 产物排除和根级类型检查范围。
- biome.json：Biome lint、formatter、include/exclude 和规则。
- .npmrc：npm 保存版本和 package release age 规则。
- .gitattributes：LF/CRLF 和二进制规则；当前 checkout 不再把大型 Code Intelligence Runtime 作为源码资产跟踪。
- .gitignore：node_modules、dist、日志、缓存、Session 数据和 Code Intelligence 产物等忽略规则。
- dev.cmd：Windows CMD 包装器。
- dev-web.cmd、dev-web.vbs、dev-web.ps1：双击启动 Web UI 且不留下控制台窗口。cmd 只把工作交给 wscript 后立即退出；vbs 以隐藏方式启动 dev-web.ps1；ps1 每次启动都先让端口上已在运行的旧实例退出（`POST /api/shutdown`，超时后仅结束确认是 MyHarness 的监听进程；端口被其他程序占用则报错而不启动），保证运行的是当前源码，再以无窗口方式运行 `dev.ps1 --web`、日志（UTF-8）写入 `data/logs/web-launch.*.log`；启动超过约 1 秒未就绪时显示一个深色无边框的小启动窗口（阶段文字来自 dev.ps1 打印的真实阶段与服务监听；右上角有最小化和关闭按钮，关闭会取消启动并结束启动进程树），就绪后自动关闭（服务打印地址，或 `GET /api/boot` 已能应答，二者任一即可）；启动失败时弹出错误对话框。`dev-web.cmd --console` 保留原来的可见窗口方式（前端文件按磁盘实时读取，刷新页面即生效；src/ 改动需重启）。
- dev.ps1：Node/npm/tsx/bash/ffmpeg 检查，以及缺依赖时的开发环境准备。
- scripts/dev-fast-loader.mjs：仅供 dev.ps1 使用的 Node `--import` 加载器，按根 tsconfig.json 的 `@myharness/*` paths 解析 workspace 源码；源码是 erasable-only TypeScript，所以不需要 tsx 转换。
- myharness-test.ps1、myharness-test.sh：从源码启动 packages/coding-agent/src/cli.ts。
- test.sh：清理部分 Provider 环境变量后执行 workspace 测试；它会临时移动用户 auth 文件，因此不是严格零写入脚本。
- .github/workflows/ci.yml：正式 CI baseline；使用 `windows-2022` 与 `windows-2025` matrix 执行安装、构建、检查和测试流程。
- .husky/pre-commit：提交前检查；其中调用的 npm run check 包含 Biome --write。
- scripts/：并行检查、lockfile、browser smoke、发布、profile 和 Code Intelligence 安装验证脚本。真实语言服务器归档不在源码 checkout 中。
- system-prompts/：实际的系统提示 Markdown 资源，不是 TypeScript loader。

## 4. packages/coding-agent/src 模块地图

当前顶级目录如下：

~~~text
agent/ application/ bun/ cli/ config/ context/ extensions/ exports/
git/ modes/ observability/ platform/ prompts/ providers/ session/
skills/ symbols/ system-prompts/ themes/ tools/ ultracode/ utils/ workflow/
~~~

### 模块归属表

| 模块 | 主要职责 | 当前边界 / 不负责 | 主要入口和调用者 | 新代码通常放在哪里 |
| --- | --- | --- | --- | --- |
| agent/ | Agent 生命周期、delegation、vision 和 runtime 服务 | 不负责 TUI 绘制；底层循环由 packages/agent 承担 | agent/runtime/agent-session.ts、sdk.ts、services.ts、session-runtime.ts、session-bridge.ts（owner 进程向其他进程开放会话）、mirror-agent-session.ts（附着到别的进程正在运行的会话）；由 main.ts、Interactive/Print mode、SDK 调用 | AgentSession 生命周期、运行状态、服务组装或 Agent 专属协调器 |
| application/ | ResourceLoader、Project Trust、Workspace Store 和 Git/Provider/Workspace/Session use case | 不是万能 domain 目录；use case 不应承载 TUI component；不是当前独立 bootstrap | application/resource-loader.ts、project-trust.ts、workspace-store.ts、use-cases/；由 main.ts 和 InteractiveMode 调用 | 跨多个底层领域的产品操作流程；单一领域逻辑仍放回对应领域 |
| cli/ | 参数解析、帮助、启动选择、Session picker、Slash Command 解析和文件输入 | 不负责模型请求、Session persistence 或 TUI 组件实现 | cli/args.ts、cli/help.ts、cli/slash-commands.ts；由 cli.ts、main.ts、AgentSession 使用 | 新 CLI option、内置 Slash Command 的解析或启动输入处理 |
| config/ | Settings、路径、Trust store、Settings migration 和持久化协调 | 不负责 Provider credential 细节；不负责 Prompt 内容 | config/settings/、config/paths/、config/trust/；由 main.ts、Provider、ResourceLoader 使用 | 新 Settings 字段、scope、migration、Trust 或配置路径 |
| context/ | Context item、窗口预算、Policy、项目上下文、文件 diff、Compact 和 branch summary | 不负责 JSONL 文件格式本身；不负责 TUI 展示 | context/coordinator.ts、context/compact/、context/project-context-loader.ts；由 AgentSession 和 Session Projection 使用 | Context 计算、截断、Compact、项目上下文和注入策略 |
| extensions/ | Extension contracts、发现、加载、API entry、Runner、事件、Tool、Command、UI、Provider 注册 | 不应让 loader 通过公共根 facade 反向依赖自身；不把 Extension API 逻辑塞进 TUI | extensions/contracts/、api-entry.ts、loader/、runtime/；由 ResourceLoader、AgentSession、ModelRuntime 使用 | 新 Extension contract、registration、lifecycle、loader 或 runtime 能力 |
| exports/ | Session HTML/JSONL 导出、模板和 ANSI/Markdown 转换 | 不是 npm package exports 配置；不负责普通 Public API re-export | exports/html/；由 AgentSession export 方法调用 | 新导出格式、模板或 export renderer |
| git/ | Git repository、命令、状态、commit、checkpoint、local repository、worktree | 不负责页面交互；业务流程入口可在 Application use case，但 Git 原语仍在此 | git/repository/、checkpoints/、worktrees/、local-repositories/；由 AgentSession、Application、InteractiveMode 使用 | Git 状态/命令、checkpoint、commit 或 worktree 原语 |
| modes/ | InteractiveMode 的输入/UI 编排，PrintMode 的 text/json 输出，以及 Web mode（`modes/web/`：loopback HTTP/SSE 服务、WebHost、路由、WebLifecycle（最后一个页面断开后按 `webShutdownGraceSeconds` 宽限退出）；浏览器前端静态文件在包根 `web/`） | InteractiveMode 当前仍直接使用部分 Application/Git/Provider/Session 服务；Web mode 只做传输与展示投影，调用现有 use case，不复制 Agent/Session/Git/Provider 逻辑；均不应成为核心业务状态机 | modes/interactive/interactive-mode.ts、modes/print-mode.ts、modes/web/web-mode.ts；由 main.ts 创建 | 产品页面、输入事件和输出模式；可复用终端基础组件放 packages/tui；Web UI 见 packages/coding-agent/docs/web-ui.md |
| observability/ | Runtime trace、usage totals、cache stats、诊断脱敏、telemetry 和 timing | 不负责业务状态持久化；Trace 不是 Session JSONL | observability/runtime-trace.ts、session-trace.ts、diagnostic-sanitizer.ts；由 AgentSession/Provider 使用 | 新运行诊断、脱敏、usage 或 trace 事件 |
| platform/ | HTTP dispatcher、进程执行、输出保护和 OS/命令边界 | 不负责 Provider 选择、Agent 状态或 TUI | platform/process/；由 Shell、Provider 和启动逻辑使用 | Node/Windows/Bash 进程与网络适配 |
| prompts/ | Prompt Template 的发现和加载 | 不负责 system prompt 的核心组装；不负责 Skills | prompts/loader/；由 ResourceLoader、AgentSession 调用 | Prompt Template loader 或 template 资源接线 |
| providers/ | 产品层 ModelRuntime、Provider/Model 配置、Credential、Recovery、balance、resolver | 不负责低层 Provider API adapter 的全部实现；不把 Provider 状态放进 TUI | providers/runtime/provider-runtime.ts、credentials/、models/、recovery/；由 Agent Runtime、InteractiveMode、Extensions 使用 | Provider runtime、credential resolution、model config 或 recovery |
| session/ | Session JSONL v3、SessionManager、Projection、Migration、branch/fork 和文件操作；写入锁与 `<session>.jsonl.bridge`（bridge/descriptor.ts） | 不负责 Agent Loop；不应在 TUI 中直接实现 Session file schema | session/manager/、projection/、migrations/、storage/jsonl/、bridge/、types/ | Session entry、tree/projection、JSONL storage 或 migration |
| skills/ | Skill 发现和加载 | 不负责 Skill 内容之外的 Agent 执行循环 | skills/loader/；由 ResourceLoader 使用 | Skill loader、来源优先级和资源接线 |
| symbols/ | lightweight index、semantic LSP、router、server 管理、symbol store 和 runtime 配置 | 不负责普通 Tool UI；不假设当前机器一定有可用 LSP | symbols/runtime/、index/、semantic/、lsp/、store/；由 tools/symbols-runtime.ts 和 Agent services 使用 | Code Intelligence backend、router、协议和索引能力 |
| system-prompts/ | System Prompt loader/composer 的代码入口 | 实际 Prompt 文本不在此目录；文本资源在仓库根 system-prompts/ | system-prompts/loader/、composer/；由 Agent Runtime 创建系统提示 | loader、composer、role boundary、prompt injection 顺序 |
| themes/ | Theme resource 的加载和资源转换 | 不负责通用 TUI 绘制；Theme resource 不等于 TUI Theme | themes/loader/；由 ResourceLoader 和 Interactive theme controller 使用 | Theme resource loader、校验和来源信息 |
| tools/ | Tool contract、registry、built-in Tool、wrapper、结果持久化和 presentation | Tool execution contract 不应依赖具体 TUI；presentation 不应承担执行状态 | tools/registry.ts、contracts/、presentation/、files/、shell/、symbols.ts、sub-agent.ts、web-search/ | 新 Tool 的执行、schema、结果或展示适配 |
| ultracode/ | UltraCode investigation profile 和 Tool kind 配置 | 不是第二套独立 Agent Loop；执行引擎在 Workflow | ultracode/profile.ts；由 Workflow engine 使用 | UltraCode profile 或 profile-specific options |
| workflow/ | 多阶段 investigation、Sub-agent、deadline、cancel、progress 和 workflow Tool | 不负责普通 Tool registry 以外的所有 Agent 行为 | workflow/engine.ts、workflow/tool.ts；由 Tool registry、Slash Commands 调用 | 新 Workflow phase、控制、状态或 workflow Tool |
| utils/ | 没有明确领域归属、可复用且低副作用的辅助函数 | 不应成为跨领域业务逻辑或“放不下的代码”目录 | 各模块按需调用 | 只有在不属于已有领域、且确实可复用时才放这里 |

### Web Search 组合边界

可选的联网搜索能力沿用现有 Agent Loop 和 Tool Result persistence，不建立第二套 Agent 或结果系统，也不依赖外部搜索/抓取服务：

```text
Agent Loop
  → tools/registry.ts
  → tools/web-search/tool.ts            web_search / web_fetch 的 schema 与结果格式
  → tools/web-search/service.ts         多 query × 多引擎、合并去重排序、引擎退避、共享下载上限、缓存
       ├── engine-runner.ts             HTTP 优先、访问拦截分类、Firefox 兜底和引擎冷却
       ├── engines/*.ts                 Google / Bing / DuckDuckGo / Brave / Brave API 引擎与解析器
       ├── transport.ts                 HTTP 与 Firefox Browser Transport contract
       ├── browser/*.ts                 专用 Firefox profile、扩展、localhost bridge、RDP
       ├── page.ts                      网页下载、逐跳 URL/DNS 安全检查、HTML → Markdown
       ├── url.ts                       URL policy（SSRF）与规范化
       └── cache.ts                     Session-scoped WebSearchCache
  → existing Tool Result persistence / Session lifecycle
```

`SettingsManager` 保存全局 `webSearch` 配置（引擎、Firefox Fallback 和三个数量，范围由 `WEB_SEARCH_SETTING_RANGES` 统一定义；当前默认引擎是 Google 与 Bing）并负责迁移旧 SearXNG/Crawl4AI 字段；Brave Search API Key 由 `providers/credentials/web-search-keys.ts` 保存在独立的私有文件中。Google/Bing 等网页引擎先走轻量 HTTP，只有验证码、限流、403、需要 JavaScript、同意页或 Bing 降级结果等访问拦截才允许切到 Firefox；API Engine 是独立可选路径，不是 Google/Bing 的兜底。Firefox Fallback 可以关闭，且使用与用户 Firefox 隔离的 MyHarness 专用 profile；遇到真实 CAPTCHA/consent 时，交互模式可要求用户在弹出的 Firefox 中人工完成验证，无人值守模式返回 `challenge_required`。`AgentSession` 根据开关重建当前 Tool registry 和 system prompt。搜索规划（搜什么、搜几轮、读哪些页）由 Agent 决定，工具只负责有限并发、缓存、取消、超时和逐项诊断。InteractiveMode 只负责 `/settings` 的产品交互，不能承载搜索业务逻辑。

### 当前不存在的目录

以下目录不是当前 coding-agent/src 的真实模块，不能作为新代码默认归属：

~~~text
src/core/
src/frontend/
src/shared/
src/application/bootstrap/
~~~

历史文档中的这些路径必须按历史记录理解；新增代码应使用当前实际目录。

## 5. 新增代码应该放在哪里

| 能力 | 起点 | 通常涉及 | 通常不应从哪里开始 |
| --- | --- | --- | --- |
| Agent 生命周期、run state、abort、follow-up | agent/runtime/ | agent-session.ts、services.ts、session-runtime.ts、Agent Core | modes/interactive/components/ |
| Context / Compact / branch summary | context/ | coordinator.ts、compact/、Session Projection、System Prompt | Session storage 或 TUI |
| Session persistence / 新 entry | session/ | types/、manager/、projection/、migrations/、storage/jsonl/ | AgentSession 内直接拼 JSONL |
| Git commit / checkpoint / worktree | Git 对应子目录 | git/repository/、checkpoints/、worktrees/；跨领域流程再加 application/use-cases/ | Interactive component 内直接实现 Git 规则 |
| Provider runtime | providers/runtime/ | Model resolver、Recovery、attribution、Settings | TUI 或 main.ts 内增加 Provider 状态 |
| Credential / OAuth | providers/credentials/ | auth-storage.ts、manager、runtime、account connections | Settings JSON 或普通 utils/ |
| Model 配置 / Custom Provider | providers/models/ | config、composer、custom-provider-manager、thinking-capability（判断 Thinking Effort 来源，优先级：官方文档 > 模型目录 > 探测，不按模型名猜测）、official-effort（Provider 官方文档明确写出的“请求档位 → 实际档位”，只匹配第一方 API host 上有文档依据的模型）、thinking-probe（真实最小请求探测 Thinking Effort，按 API 协议区分）、store | 直接修改 TUI model selector |
| 低层 Provider API adapter | packages/ai/src/api/ | packages/ai/src/models.ts、auth helpers、Provider API 类型 | coding-agent 的 InteractiveMode |
| 新 Tool | tools/ | contract、具体 Tool、registry、wrapper、presentation；Extension Tool 则走 extensions/ | AgentSession 中内联 Tool 执行 |
| TUI 页面/产品 UI | modes/interactive/ | interactive-mode.ts、components/、theme | Provider、Session 或 Git 目录 |
| Web UI 服务端 / API / 事件 | modes/web/ | routes-*.ts、host.ts、wire.ts；前端在 packages/coding-agent/web/ | 在路由里复制 Session/Git/Provider 规则；把 UI 状态机放进 host.ts |
| 可复用 TUI 基础组件 | packages/tui/src/ | TUI component、terminal、focus/input 基础能力 | coding-agent 的业务模块 |
| Extension API | extensions/contracts/、api-entry.ts | loader、runtime、Runner、compat、examples | 直接把内部实现暴露给 Extension |
| 内置 Slash Command | cli/slash-commands.ts（唯一注册表，含别名与 `surfaces`：cli / web；TUI 与 Web `/api/resources` 共用） | AgentSession prompt expansion、Interactive dispatch、Web 的 web/js/builtin-commands.js 执行方式表 或 Extension registration | TUI component 中硬编码完整业务流程 |
| `/settings` 菜单 | cli/settings-menu.ts（唯一定义：行、顺序、名称、说明、固定选项与 `surfaces`；TUI 与 Web `GET /api/settings` 的 `menu` 共用） | TUI 的 settings-selector.ts（如何绘制和打开）、Web 的 routes-settings.ts `SETTINGS_MENU_SETTING` 与 web/js/settings-menu.js（如何打开） | 在 TUI 或 Web 里另写一份菜单行、名称或选项 |
| System Prompt 内容 | 根目录 system-prompts/ | 对应 role/tool/task/provider Markdown | src/system-prompts/ 中写大段实际 prompt 文本 |
| System Prompt 加载/组装 | system-prompts/ | packages/ai loader、coding-agent loader/composer | TUI 或 Provider adapter |
| Settings | config/settings/ | types、defaults、manager、storage、migration、paths | 任意业务模块中直接读写 JSON |
| Project Trust | config/trust/、application/project-trust.ts | Trust store、settings access、ResourceLoader | 通过 UI 状态代替 Trust store |
| OS、进程、HTTP | platform/process/ | exec、PowerShell、Bash、HTTP dispatcher、output guard | utils/ 中复制一套进程执行器 |
| Code Intelligence | symbols/、tools/symbols-runtime.ts | backend、router、LSP、store、Windows 按语言安装的可选模块 | 普通 File Tool 或 TUI 中直接调用 LSP |
| Workflow / UltraCode | workflow/、ultracode/ | engine、tool、profile、Sub-agent | AgentSession 中另写一套 phase engine |
| 通用 helper | utils/ | 仅限无明确领域、低副作用、确实跨模块复用的函数 | 把业务状态塞入 utils/ |

优先使用已有领域目录。只有当功能不属于现有领域、且新顶级模块的职责能够被清楚定义时，才考虑建立新的顶级目录。

## 6. 依赖规则

### 当前已观察到的依赖

- main.ts 和 agent/runtime/services.ts 负责组合大量子系统。
- AgentSession 是高层产品门面，直接持有 Agent、Session、Settings、ModelRuntime、ResourceLoader、Tool registry、Context、Git checkpoint、Extension、Trace 等对象。
- InteractiveMode 的主要 Agent 执行委托给 AgentSession，但当前源码仍直接导入 Application use cases、Git、Provider 和 Session 相关服务。
- Application use cases 当前没有导入 TUI component、Theme 或 InteractiveMode；Phase architecture tests 也检查这一点。
- Tool execution 模块与 tools/presentation/ 分开；presentation 负责 renderer/schema/prompt 侧展示接线。
- src/index.ts 是 coding-agent 的公共 facade；当前内部源码扫描未发现内部模块通过这个根 facade 反向引用自己的实现。
- workflow/engine.ts、Tool registry、Sub-agent 和 ultracode/profile.ts 之间存在实际交叉引用。
- packages/agent/src/harness/types.ts 与 packages/agent/src/index.ts 存在 type/re-export 级循环；symbols 和 extensions 也有静态循环组件。

### 长期应保持的边界

以下是维护规则，不表示当前所有代码已经完全达到理想边界：

当前没有单独的 domain/ 顶级模块；可复用契约分布在 Agent Core types、session/types、tools/contracts、extensions/contracts 和 providers/models 等领域目录，Runtime 负责把这些契约与服务组装起来。

1. UI 负责输入、展示和交互流程；核心业务状态机、Provider recovery、Session schema、Git safety 和 Compaction 不应因为方便而迁入具体 TUI component。
2. Application use case 负责跨领域的产品操作流程；单一领域的细节应留在对应的 Session、Git、Provider 或 Workspace 模块。
3. packages/agent 保持为 Provider 无关的 Agent Core；Provider API 选择和 MyHarness 配置留在 ai/coding-agent。
4. Platform 模块承接 Node、Windows、Bash、HTTP 和进程差异；上层不应各自复制 subprocess 或 output guard。
5. contracts/ 只定义稳定、可传递的契约和 registration 记录，不把具体 TUI、Theme 或大而全的 Session 实现塞进 contract。
6. Tool execution 和 Tool presentation 分开。修改 Tool 行为时，先确认是否需要同步 presentation；不要为了 renderer 把 TUI 依赖放回执行模块。
7. Prompt 内容、Prompt loader、Prompt composer、Project context 和 Skills 是不同层次；修改其中一层时不要顺手把其他层合并。
8. Package 根 index.ts 是公共边界。内部模块优先使用真实内部模块路径；不要通过 Public facade 访问自己，也不要仅为减少 import 行数扩大公共导出。
9. compat、deprecated alias 和旧格式 migration 属于兼容边界。不能因为名字旧就删除；必须先检查 Public API、第三方 Extension、已有 Session/Settings 和 migration 测试。
10. 当前已知的静态循环只能记录和验证，不能在普通功能任务中顺手重构；运行时影响需要实际验证。

## 7. 核心运行链路

### CLI 启动链

~~~text
dev.cmd / myharness-test.ps1 / installed myharness
        ↓
src/cli.ts
        ↓ configureHttpDispatcher()
src/main.ts
        ↓
parse args → bootstrap Settings → handle help/config/package commands
        ↓
resolve app mode → migrations → Trust → Session Manager
        ↓
createAgentSessionRuntime()
        ↓
InteractiveMode.run()、runPrintMode() 或 runWebMode()（`--web`；HTTP 服务先于 runtime 启动，以便在浏览器里回答 Project Trust）
~~~

### Agent 执行链

~~~text
AgentSession.prompt()
   ↓
slash command / prompt template / skill / attachment processing
   ↓
model and auth validation
   ↓
Agent Core Agent.prompt()
   ↓
streamFunction → ModelRuntime.streamSimple()
   ↓
Agent Loop events / Tool calls / assistant response
   ↓
Session append + observability + UI/print events
~~~

### Provider 调用链

~~~text
AgentSession
  → ModelRuntime
  → providers/runtime/provider-runtime.ts
  → credential/model resolution
  → packages/ai Provider / Models
  → packages/ai/src/api/*
  → Provider SDK / HTTP endpoint
~~~


### Session persistence 链

~~~text
AgentSession
  → SessionManager
  → data/workspace-store + config/paths
  → projection / migration
  → session/storage/jsonl
  → <project root>/data/workspaces/<workspace-id>/sessions/<session-id>/conversation/*.jsonl
~~~

Code Intelligence 的存储与产品 Session 分开：轻量索引在源码内运行；可选
Windows 语言模块由 `symbols/runtime/installation.ts` 安装到
`%USERPROFILE%\\.myharness\\agent\\code-intelligence\\`，语义 workspace 数据在
该目录的 hash 子目录中。正常启动不会下载模块；当前 manifest 未发布时，
语义模块状态为 unavailable。

### TUI 链

~~~text
InteractiveMode
  → coding-agent interactive components
  → @myharness/tui
  → terminal renderer / input / focus / theme
~~~

### Tool 执行链

~~~text
Agent Core tool call
  → AgentSession Tool registry
  → ToolDefinition wrapper
  → built-in / custom / extension Tool
  → result persistence
  → presentation renderer / event output
~~~

### Extension 加载链

~~~text
ResourceLoader
  → extensions/loader
  → discover extension path / package manifest
  → api-entry.ts + contracts
  → createExtensionRuntime()
  → ExtensionRunner
  → commands / tools / providers / UI / event hooks
~~~

### System Prompt 组装链

~~~text
root system-prompts/*.md
  → packages/ai system-prompt-loader
  → coding-agent system-prompts/loader
  → ResourceLoader project resources / context loader
  → system-prompts/composer/buildSystemPrompt
  → role / tools / context / skills / model injection
  → Agent Core initial system message
~~~

## 8. Public API、Internal API 和 Compatibility

### coding-agent

packages/coding-agent/package.json 当前只声明 package export "."。源码公共 facade 是 packages/coding-agent/src/index.ts，主要集中 re-export：

- AgentSession、AgentSessionRuntime 和 createAgentSession* SDK 工厂。
- Session types、Manager、Projection、JSONL helpers 和 migration 类型。
- Settings、Trust、Config paths、Context、Compaction。
- Provider credentials、ModelRuntime、Model Resolver。
- Extension API、contracts、compat types、ExtensionRunner 和 loader 相关公共类型。
- Tool contracts、Tool factories、result 和 presentation 类型。
- Git/local repository、Workspace、HTML/JSONL export。
- Symbols API、Code Intelligence 类型。
- InteractiveMode、runPrintMode 和部分 UI component/theme utilities。
- main、Skills、Prompt 和其他 SDK 辅助类型。

src/agent/、src/session/、src/providers/ 等目录中的具体文件仍是内部实现路径；它们存在于源码中不代表自动成为 npm subpath API。

### 其他 Package

- packages/agent/package.json 暴露 "." 和 "./node"。
- packages/ai/package.json 暴露 root、./compat、./providers/all、./providers/faux、./api/*、./auth/*、./oauth、./bedrock-provider、./bun-oauth 等声明的入口。
- packages/tui/package.json 暴露 root。
- packages/storage/sqlite-node/package.json 暴露 root。

### 当前 Compatibility 层

当前仍能在源码中确认：

- packages/ai/src/compat.ts：旧的全局 AI API、Provider/Model registry 和 lazy API 的兼容入口。
- packages/coding-agent/src/extensions/compat/：Extension 类型、Tool wrapper 等兼容层。
- packages/coding-agent/src/providers/models/registry.ts：面向部分 Extension/UI 调用方的 Model registry facade。
- packages/coding-agent/src/symbols/legacy-adapter/：Symbols 旧适配层。
- AgentSession 中标记 deprecated 的 ContextBudgetState alias。
- 多个当前文件仍直接导入 @myharness/ai/compat。

修改 Public API、Session entry、Settings、Credential、Extension contract 或兼容层前，至少要检查：

1. package.json 的 exports、src/index.ts 和声明生成路径。
2. 当前测试、examples 和现有 Extension 的 import。
3. migration、旧格式读取和 deprecated alias 的行为。
4. 对应专题文档和 changelog/发布说明是否需要同步。

## 9. 常见开发场景

| 场景 | 从哪里开始看 | 通常修改 | 通常不应修改 | 文档和验证 |
| --- | --- | --- | --- | --- |
| 新增 Tool | tools/registry.ts 和现有同类 Tool | tools/contracts/、具体 Tool、wrapper、presentation；Extension Tool 还涉及 extensions/ | 不要在 TUI 中实现核心执行；不要复制 Shell/File executor | docs/extensions.md 或 README；运行相关 Tool tests 和 coding-agent tests |
| 修改 Tool | 目标 Tool 和 tool-result-persistence.ts | schema、执行、details、错误和 renderer | 不要无理由改变 Tool name、结果格式或 Session entry | 检查 Tool、AgentSession、presentation 和相关 regression tests |
| 新增 Provider | providers/runtime/provider-runtime.ts、packages/ai/src/models.ts | Provider config、credential、model composition；低层 API adapter 放 packages/ai/src/api/ | 不要在 InteractiveMode 中拼 Provider 请求 | docs/providers.md、docs/custom-provider.md；Provider/config/auth tests |
| 新增 Model 配置 | providers/models/ 和 models.json 解析逻辑 | composer、custom provider manager、store 或 Extension provider | 不要把静态 model entry 硬编码进 UI | docs/models.md；configured/dynamic provider tests |
| 修改 Credential | providers/credentials/auth-storage.ts | Auth storage、resolution、OAuth/account connection | 不要把 key 放入 Settings 或日志 | docs/security.md、docs/providers.md；auth/credential tests；严禁输出真实 secret |
| 新增 Slash Command | cli/slash-commands.ts、AgentSession.prompt() | parse、builtin expansion、Interactive dispatch 或 Extension registration | 不要只在某个页面写命令分支 | docs/usage.md；CLI/slash/AgentSession tests |
| 新增 Git 功能 | git/repository/、checkpoints/、worktrees/ | Git 原语；跨领域流程再加 application/use-cases/ | 不要在 component 内直接管理 ref、index 或安全判断 | docs/worktrees.md、docs/development.md；Git/checkpoint/worktree tests |
| 新增 Worktree 功能 | git/worktrees/manager.ts 和 application/use-cases/git-worktree.ts | manager、use case、Workspace/launcher 接线 | 不要复制 Git worktree 命令 | docs/worktrees.md；phase10/worktree tests |
| 新增 Session entry | session/types.ts、session/manager/、projection/ | 类型、append、projection、context 语义 | 不要只修改 UI 序列化；不要跳过 migration 影响旧文件 | docs/session-format.md；Session manager/tree/migration tests |
| 修改 Session persistence | session/storage/jsonl/、migrations/ | parser、writer、migration、relocation | 不要直接删除旧格式支持 | docs/sessions.md、docs/session-format.md；完整相关 Session tests |
| 修改 Compaction | context/compact/、context/coordinator.ts | cut point、summary、serialization、usage 和 settings | 不要在 TUI 中重新实现 context 保留规则 | docs/compaction.md；compaction/context/AgentSession tests |
| 新增 Extension API | extensions/contracts/、api-entry.ts、runtime/ | contract、registration、Runner、compat 和 examples | 不要直接暴露内部实现对象或通过 root facade 反向接入 | docs/extensions.md、examples；extension discovery/runner tests |
| 修改 System Prompt | 根目录 system-prompts/ 或 loader/composer | 内容改资源文件；加载顺序改 loader/composer | 不要把实际 prompt 文本散落到 TUI/Provider 代码 | system-prompts/README.md；system-prompt tests |
| 新增 Skill | skills/loader/、ResourceLoader 和资源目录 | discovery、priority、Trust 和 Skill resource | 不要把 Skill 逻辑硬编码进 AgentSession | docs/skills.md；resource/skill tests |
| 新增 Code Intelligence 能力 | symbols/、tools/symbols-runtime.ts、symbols/runtime/installation.ts | backend、router、LSP、store、按语言安装的 Windows 模块 | 不要假设所有机器都安装同一 LSP | Code Intelligence docs/tests、发布归档 E2E（需要运行时确认） |
| 修改 TUI 页面/组件 | modes/interactive/ 或 packages/tui/src/ | 产品页面放前者；可复用终端原语放后者 | 不要把业务状态机放入渲染 component | docs/tui.md；TUI 和受影响 coding-agent tests |
| 新增 Application use case | application/use-cases/ | 跨领域流程和结果类型 | 不要导入具体 TUI 或重写底层领域逻辑 | docs/development.md、架构手册；phase3/use-case tests |
| 修改启动流程 | cli.ts、main.ts、config.ts、bun/、Windows scripts | 参数、bootstrap、mode、asset/runtime path | 不要让启动器偷偷执行无关写入或绕过 Session/Trust | CLI/config tests；Windows/Bun 行为需单独运行时确认 |

## 10. 配置和持久化

默认 Agent directory 是 ~/.myharness/agent；Windows 对应 %USERPROFILE%\\.myharness\\agent，负责全局配置和 credentials。项目级配置仍在 `<cwd>/.myharness/`；用户运行时数据统一在 `<cwd>/data/`，当前 Session 数据按 Workspace/Session 作用域保存。环境变量和 config.ts 可以覆盖部分路径。

| 数据 | 默认位置 | 格式 | 代码负责人 | 修改风险 |
| --- | --- | --- | --- | --- |
| Global Settings | ~/.myharness/agent/settings.json | JSON | config/settings/、SettingsManager | 影响所有项目和启动默认值 |
| Project Settings | <cwd>/.myharness/settings.json | JSON | config/settings/、Project Trust | 影响单个项目；受 Trust 控制 |
| Trust | ~/.myharness/agent/trust.json | JSON | config/trust/、ProjectTrustStore | 影响项目资源、Settings、Extension、Skill、Prompt 的读取 |
| Credentials | ~/.myharness/agent/auth.json | JSON | providers/credentials/、AuthStorage | 涉及 API Key/OAuth；不能打印或复制真实内容 |
| Account connections | ~/.myharness/agent/account-connections.json | JSON | providers/credentials/ | 可能涉及第三方账号授权 |
| Model config | ~/.myharness/agent/models.json | JSON | providers/models/、ModelRuntime | 影响 Provider/Model 解析和可用性 |
| Model catalog cache | ~/.myharness/agent/models-store.json | JSON | providers/models/store.ts | 影响 offline catalog 和刷新结果 |
| Workspace records | <project root>/data/workspaces/registry.json；每个 Workspace 另有 `workspaces/<workspace-id>/metadata/workspace.json`；迁移 marker/archive 同目录 | JSON | data/workspace-store.ts、data/workspace-registry-migration.ts、config/paths/；application facade | 影响 Workspace 列表、稳定 ID、路径规范化和可恢复迁移 |
| Local Git Repository records | ~/.myharness/agent/local-git-repositories.json | JSON | git/local-repositories/store.ts | 影响已注册本地仓库路径 |
| Session | <project root>/data/workspaces/<workspace-id>/sessions/<session-id>/conversation/*.jsonl；Session metadata 在同一 Session 的 `metadata/session.json` | JSONL + JSON | session/manager/、storage/jsonl/、session/migrations/ | 影响已有对话、branch、resume、fork 和历史兼容 |
| Code Intelligence modules | Windows `%USERPROFILE%\\.myharness\\agent\\code-intelligence\\modules/`、shared components 和 `data/<workspace-hash>/` | archives、state JSON、semantic workspace data | symbols/runtime/installation.ts、symbols/runtime/runtime.ts | 可重新生成；不属于项目 Session，也不应进入 Git |
| Checkpoint metadata | ~/.myharness/agent/checkpoints/<session>/<checkpoint>/checkpoint.json | JSON | git/checkpoints/ | 影响恢复和 Git 安全边界 |
| Checkpoint refs | Git repository 内 refs/myharness/checkpoints/... | Git refs | git/checkpoints/checkpoint.ts | 影响仓库状态和恢复 |
| Runtime trace | ~/.myharness/agent/traces/<session>/<run>.jsonl | JSONL | observability/runtime-trace.ts | 可能包含诊断数据，写入前必须脱敏 |
| System Prompt | 仓库根 system-prompts/；也支持全局/项目资源 | Markdown | packages/ai loader、coding-agent composer | 直接影响 Agent 行为和安全边界 |
| Themes | 全局/项目 themes 资源目录和 package assets | JSON/资源文件 | themes/loader/、Interactive theme | 影响 UI 资源加载，不等于 Settings JSON |
| Skills | 全局/项目 skills 目录和 package resources | Markdown/资源文件 | skills/loader/、ResourceLoader | 影响可注入的 Agent instructions |

### Session 与 SQLite 的边界

当前 coding-agent SessionManager 直接使用 JSONL storage、projection 和 migration；coding-agent source 没有导入 packages/storage/sqlite-node。后者是 packages/agent 通用 Session abstraction 的独立 backend，不属于当前 CLI 的 Session 持久化路径。

### Workspace / Session 数据边界

`WorkspaceStore` 以规范化的真实 Workspace 根目录作为身份键，`registry.json` 只保存 Workspace 记录；Session 创建、resume、fork 和 import 通过同一 Workspace resolver 获取 `workspace-id`，再由 `config/paths/` 生成 `sessions/<session-id>/` 下的路径。Session 列表和旧 Session 打开路径不会为了显示或读取而注册 Workspace。不属于任何已登记 Workspace 的 Session（Web UI 里不选 Workspace 新建的 Chat，以及被“从列表移除”的 Workspace 留下的 Chat）是“未绑定”Session：前者存放在保留容器 `workspaces/unbound/`（不进 registry，运行在 `<agent dir>/default-workspace/` 这个 MyHarness 内部默认工作目录），后者的数据留在原 `workspaces/<workspace-id>/` 不动；移除 Workspace 只删 registry 记录，同一文件夹再次添加时沿用原 ID。判断与列出见 `SessionManager.isUnbound()` / `listUnbound()`，后续新建沿用同类归属见 `SessionManager.createLike()`。`data/sessions/` 只作为显式迁移的兼容来源；正常启动、Session 列表和新 Session 创建不会再读取或写入它，迁移成功且确认只剩空目录后会移除该已退役目录。

### 写入安全

Settings、Credentials、Workspace 和部分 Model/Session/Git metadata 使用 locking、临时文件或 atomic rename。修改这些模块时必须保留现有写入边界、旧格式读取和权限语义。

## 11. System Prompt、Prompt Template、Skill 和项目上下文

这些资源不是同一个目录：

~~~text
system-prompts/                         实际系统提示 Markdown 内容
packages/ai/src/api/system-prompt-loader.ts
                                         基础文件定位、读取和变量处理
packages/coding-agent/src/system-prompts/loader/
                                         coding-agent 侧 prompt resource 接线
packages/coding-agent/src/system-prompts/composer/
                                         系统提示顺序和 role boundary 组装
packages/coding-agent/src/prompts/loader/
                                         Prompt Template loader
packages/coding-agent/src/skills/loader/
                                         Skill loader
context/project-context-loader.ts        项目上下文文件
~~~

系统提示资源由 packages/ai loader 按环境选择：环境变量覆盖、Bun executable adjacent、monorepo root 或安装包旁的 system-prompts。当前资源加载顺序由 composer 组织，包含 global core、Tool/routing/guidelines、custom/append、project context、Skills、working directory、Model、output language 和 role boundary。

项目中的 `AGENTS.md`、`CLAUDE.md` 等上下文文件由
`context/project-context-loader.ts` 处理；它们从全局 Agent 目录开始，再按
最上层 ancestor 到当前 cwd 的顺序进入 composer，并与仓库根 `AGENTS.md` 作为
开发规则入口的职责区分开。`AGENTS.md`/`CLAUDE.md` 不在 Project Trust 的
protected resource 列表中，除非使用 `--no-context-files`，否则即使项目未受信任
也会作为纯文本上下文加载；角色过滤仍由 context policy 和 composer 执行。

用户的 `SYSTEM.md` 和 `APPEND_SYSTEM.md` 是另一条由
`system-prompts/loader/` 负责的输入链：受信任时 `<cwd>/.myharness/SYSTEM.md`
或 `APPEND_SYSTEM.md` 优先于全局 `<agentDir>/SYSTEM.md` 或对应 append 文件；
不受信任时回退全局文件。每个名称只选择一个有效来源，项目文件不是与全局文件
简单叠加；`SYSTEM.md` 作为 custom system prompt，`APPEND_SYSTEM.md` 作为追加
内容进入 composer。它们都不是根 `system-prompts/` 静态资源，也不承载本仓库的
CI 或开发规则。

## 12. Build、Test 和 Validation

### CI 与平台验证边界

正式 `.github/workflows/ci.yml` 的两个 GitHub runner 是 `windows-2022` 和
`windows-2025`，matrix 两边必须都通过。它们证明的是该 workflow 在两个
Windows Server 环境中的安装、构建、检查和测试结果；不能替代最终用户 Windows
桌面 x64 的完整支持矩阵，也不能单凭 CI 结果声称 Windows 10/11 每个版本、真实
Provider、OAuth、终端或 LSP 已验证。`.github/workflows/` 中的 release、audit
和协作 workflow 另有自己的运行环境，不是这条正式 CI baseline 的额外平台承诺。

### 常用命令

| 命令 | 实际作用 | 是否严格只读 |
| --- | --- | --- |
| npm run build | 按 tui → ai → agent → sqlite-node → coding-agent 构建并复制资源 | 否，会写 dist/assets |
| npm run build:offline | offline 方式构建，仍会写构建产物 | 否 |
| npm test | 运行有 test script 的 workspace | 不保证；测试可能使用临时文件、缓存或用户路径 |
| npm --workspace @myharness/coding-agent test -- test/x.test.ts | 运行指定 coding-agent 测试 | 需检查测试本身的写入行为 |
| npm run check | Biome check --write 加并行检查 | 否，Biome 会修改文件 |
| node scripts/run-checks-parallel.mjs | 运行 pinned deps、imports、lock、TypeScript 和 browser smoke 检查 | 不是严格零写入；incremental/browser failure 可能产生文件 |
| npm --prefix packages/coding-agent run build:binary | 使用 Bun 生成 dist/myharness | 否 |
| npm run check:browser-smoke | 浏览器 smoke source/check | 失败时可能写错误日志 |

本手册所述测试命令只是验证入口；未执行过的命令不能在报告或提交说明中写成“已通过”。

### 测试位置

~~~text
packages/agent/test/
packages/ai/test/
packages/coding-agent/test/
packages/tui/test/
~~~

coding-agent/test/ 当前包含 AgentSession、Context/Compaction、Session、Provider、Settings、Extensions、Git、Workflow、Tools、CLI、regression、architecture 和 Code Intelligence 测试。

架构和边界测试包括：

~~~text
packages/coding-agent/test/phase1-architecture.test.ts
packages/coding-agent/test/phase2-architecture.test.ts
packages/coding-agent/test/phase3-architecture.test.ts
packages/coding-agent/test/phase5-session-architecture.test.ts
packages/coding-agent/test/phase6-config-architecture.test.ts
packages/coding-agent/test/phase7-provider-architecture.test.ts
packages/coding-agent/test/phase10-worktree-architecture.test.ts
~~~

Code Intelligence 测试位于 packages/coding-agent/test/code-intelligence/，包括 lightweight、semantic、LSP、router、integration 和 final acceptance 测试。

Windows 条件测试包括 packages/coding-agent/test/bash-close-hang-windows.test.ts。

Code Intelligence 的默认实现是 source 内轻量索引；Windows 语义模块由 `packages/coding-agent/src/symbols/runtime/installation.ts` 按语言管理，安装状态测试位于 `packages/coding-agent/test/code-intelligence/runtime-manager.test.ts`。真实语言服务器 E2E 需要已发布且有完整校验元数据的 Windows 归档，本次没有把未发布归档当作通过。scripts/smoke-cli-local-provider.mjs 也存在，但是否能在当前机器成功运行需要真实环境验证。

### 按修改范围验证

| 修改范围 | 至少检查 |
| --- | --- |
| 普通内部模块 | 目标模块测试、直接调用方和 TypeScript/import 检查 |
| Public API / package export | package.json、src/index.ts、声明构建、现有 import、兼容测试和相关 docs |
| Session / entry / migration | v1/v2/v3 读取、写入、projection、branch、resume、fork、坏输入和旧文件测试 |
| Settings / Credentials | scope merge、migration、locking/atomic write、权限、malformed input；不使用真实 secret |
| Provider / Model | configured provider、credential resolution、dynamic provider、recovery 和 API adapter 测试；真实网络能力单独标记 |
| Git / checkpoint / worktree | repository state、checkpoint create/restore、commit、worktree 和失败恢复测试 |
| Context / Compaction / Prompt | summary/cut point、serialization、context window、prompt loader/composer 和角色边界测试 |
| Tool | schema、执行结果、错误、取消、结果 persistence、presentation 和 Agent Loop tests |
| Extension | contracts、loader discovery、Runner lifecycle、Tool/Command/Provider/UI registration 和 examples |
| TUI | component/unit tests、InteractiveMode 直接调用方；必要时进行真实终端运行验证 |
| Web UI | test/web-*.test.ts（HTTP 安全、wire/changes/dialogs、前端纯逻辑、真实 runtime 的 HTTP/SSE 集成）；渲染与交互需要在真实浏览器中运行验证 |
| 启动流程 / Windows / Bun | args/help/source path、Windows wrapper、构建资源路径、Bun binary；源码静态检查不能替代实际启动 |

## 13. 高风险区域

以下区域的修改可能影响已有用户数据、兼容性、安全边界或发布产物：

- Session JSONL、Projection、Migration、Branch/Fork。
- Settings migration、Trust store 和 Project Settings scope。
- auth.json、OAuth、Credential resolution 和 account connections。
- Provider Runtime、Model catalog、Recovery 和请求 headers。
- Git checkpoint refs、metadata、Worktree 和 commit workflow。
- Public src/index.ts、package exports、Extension API 和 compat facade。
- System Prompt 内容、加载顺序、role boundary 和项目上下文注入。
- Windows launcher、PowerShell/Bash executor 和 Bun binary asset path。
- Code Intelligence 安装归档、LSP process 和 server registry。
- Runtime trace、诊断输出、用户目录和日志路径。

这些区域不能因为“只是整理目录”或“名字看起来旧”就删除、改格式或改行为。需要先确认调用方、旧格式、迁移和测试范围。

## 14. 当前已知限制和未确认区域

### 当前已确认的文档/源码边界

- packages/coding-agent/docs/development.md 的历史项目结构曾包含 packages/orchestrator，当前根目录没有该 Package；当前手册以实际五个主要 Package 为准。
- Phase architecture 文档仍是历史记录，部分内容引用旧 src/core/... 路径；它们不作为当前架构入口。
- 当前源码仍有 packages/ai/src/compat.ts、coding-agent Extension compat、Model registry facade、Symbols legacy adapter 和旧的 compat imports。
- Provider 文档中的固定 Provider 数量不能直接作为当前默认 catalog 事实；当前 packages/ai/src/providers/all.ts 的默认 catalog 为空，实际可用 Model 还取决于配置、runtime store 和 Extension。
- docs/rpc.md 保留为历史/参考文档；当前 CLI/source 未确认存在对应的独立 RPC runtime，当前使用说明指向 JSON mode 或 SDK。
- 静态 import 关系中存在若干 type/re-export 或模块级循环组件；是否影响 runtime 初始化未确认。

### 必须运行时确认的内容

- 实际 Provider、Model、API Key、OAuth 和网络请求行为。
- 当前机器上各 Code Intelligence server 的 availability、启动和 fallback。
- Bun binary 的真实启动、资源加载和平台行为。
- Interactive TUI 的真实终端交互、输入法和 Windows behavior。
- Extension 动态加载后的完整运行时依赖和第三方 Extension 兼容性。
- coding-agent 是否通过未扫描的外部入口间接使用 SQLite backend。
- myharness-debug.log 是否存在实际 writer，以及 Extension 是否形成统一的独立 state file。

## 15. 长期维护原则

1. 以当前源码、配置和测试为事实来源；历史 Phase 文档只说明历史过程。
2. 先确认功能归属，再修改已有领域模块；优先复用当前实现。
3. 保持高内聚、低耦合和清楚的依赖方向，不建立万能目录。
4. 维持 Public API、Session、Settings、Credentials、Extension contract、Git metadata 和 Prompt 行为的兼容边界。
5. 只做完成任务所需的最小完整修改，不顺手重构无关模块。
6. 不为了减少文件或 import 行数破坏现有 contract、compat 或 recovery 机制。
7. 修改后按影响范围执行最相关验证；准确区分静态检查、测试、真实运行和外部服务验证。
8. 发现代码问题时先记录证据；除非任务明确要求，不在文档或功能任务中顺手修改它。
9. 涉及用户目录、Session、Credential、Git metadata 或缓存时，优先保护数据和可恢复性。
10. 架构文档服务于定位和维护，不为了形式上的目录整齐而改变稳定用户行为。

## 16. 专题文档入口

- 总文档入口：DOCUMENTATION_INDEX.md。
- 用户入口：README.md、packages/coding-agent/README.md。
- 项目阶段和发布前边界：PROJECT_STATUS.md；长期设计决策：docs/decisions/。
- 用户数据、Session、Workspace 和 runtime 目录：docs/STORAGE.md。
- License 和归属：LICENSE、NOTICE、THIRD_PARTY_NOTICES.md。
- 根维护/开发：MAINTENANCE.md、DEVELOPMENT_ROADMAP.md。
- 文档索引：packages/coding-agent/docs/index.md。
- 开发环境：packages/coding-agent/docs/development.md。
- Coding Agent 源码模块：packages/coding-agent/docs/source-modules.md；产品维护和后续开发：packages/coding-agent/docs/maintenance.md、roadmap.md。
- Settings：packages/coding-agent/docs/settings.md。
- Provider/Model：packages/coding-agent/docs/providers.md、models.md、custom-provider.md。
- Session/Compaction：packages/coding-agent/docs/sessions.md、session-format.md、compaction.md。
- Extensions/Skills/Prompt：extensions.md、skills.md、prompt-templates.md。
- Git/Windows/TUI/SDK：worktrees.md、windows.md、tui.md、sdk.md。
- System Prompt 资源：system-prompts/README.md、maintenance.md、roadmap.md。
- Agent Core：packages/agent/README.md 和 packages/agent/docs/（index、maintenance、roadmap）。
- AI/Provider：packages/ai/README.md 和 packages/ai/docs/（index、maintenance、roadmap）。
- TUI：packages/tui/README.md 和 packages/tui/docs/（index、maintenance、roadmap）。
- SQLite Node：packages/storage/sqlite-node/README.md 和 packages/storage/sqlite-node/docs/（index、maintenance、roadmap）。
- 脚本/CI/项目配置：scripts/README.md、scripts/maintenance.md、scripts/roadmap.md；docs/maintenance/github-automation.md、.github/maintenance.md、.github/roadmap.md；.myharness/README.md、maintenance.md、roadmap.md。
