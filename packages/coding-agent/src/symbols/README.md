# symbols/ — Code Intelligence

## 说明

### 职责

为 `symbols` 工具提供基于 LSP 的代码结构和语义信息：符号、定义、引用、实现、诊断，以及 hover、workspace symbols、调用层级和类型层级。

唯一查询后端是 **语义后端（semantic）**，通过 LSP 语言服务器提供能力；语言服务器是按语言安装的可选 Windows 模块。`symbols` 工具由 `codeIntelligence.symbolsEnabled` 控制，默认关闭，开关修改后需重启运行时生效。

`router` 只负责把查询交给语义后端，并协调 Symbol Store 中已观察到的符号。纯文本搜索请使用 `grep`、`find` 或 `ls`。

### 顶层文件

| 文件 | 内容 |
| --- | --- |
| `types.ts` | 统一数据模型：位置、范围、符号、引用、诊断、各类查询结果及其来源/完整度标记。位置一律 0-based |
| `path-semantics.ts` | 路径契约：一律按 Windows 语义处理 workspace、文档路径和 `file://` URI，大小写不敏感的 identity |
| `symbol-identity.ts` | `namePath` 的构造与解析、`SymbolId` 生成 |
| `api.ts` | 本目录的统一出口 |

### index/router/

| 路径 | 内容 |
| --- | --- |
| `router.ts` | `CodeIntelligenceRouter`：把 Symbols 查询路由到语义/LSP 后端，并协调 Symbol Store |
| `policy.ts` | 语义操作与目标类型的支持策略 |
| `types.ts` | Router API、路由选项和错误边界 |

细节见 [router/README.md](index/router/README.md)。

### lsp/ — LSP 通信

| 路径 | 内容 |
| --- | --- |
| `framing.ts` | `Content-Length` 分帧 |
| `process.ts` | `LspProcess`：语言服务器子进程 |
| `client.ts` | `LspClient`：JSON-RPC 请求/通知、超时与取消 |
| `types.ts`、`errors.ts`、`uri.ts` | 协议类型、错误、URI 工具 |
| `language-server/` | `LanguageServerRegistry`（定义与选择）和 `LanguageServerManager`（进程生命周期、按 workspace 复用）。细节见 [language-server/README.md](lsp/language-server/README.md) |

### semantic/

`LspSemanticBackend`：文档同步（didOpen/didChange/didClose）、诊断订阅、把协议数据转成统一模型，以及跨文件查询（引用、重命名、实现、调用/类型层级、工作区符号）前的就绪处理。细节见 [semantic/README.md](semantic/README.md)。

### workflow/ — 面向 Agent 的组合操作

建立在 router 之上的四个 `symbols` 操作，以及 `apply_rename` 用的重命名计划。不建持久索引，也不用向量库：每次按需用 ripgrep 搜工作区当前内容，再交给语言服务器确认。

| 文件 | 内容 |
| --- | --- |
| `discovery.ts` | `find_existing`：按意图（任意语言的自然描述，可附猜测的名字）找已有实现。ripgrep 召回 → 命中归属到语言服务器给出的声明 → 按名字/注释/函数体/路径加权排序；只和猜测名字重合、不含任何行为描述词的候选降权并标注。每种语言报告覆盖方式（语义/仅文本）和失败原因，从不声称“项目里没有” |
| `slice.ts` | `read_symbol`：读单个符号的源码，带前置注释/装饰器/属性、全部重载和所在容器的签名；超长时明确截断并给出 `read` 续读参数；无语言服务器时退化为标注为 lexical 的文本窗口 |
| `impact.ts` | `impact`：改契约前的影响面。语言服务器报告的引用标为 certain（按文件分组、带调用/导入/类型等类别和所在作用域），ripgrep 找到但服务器没报告的同名文本标为 possible |
| `rename.ts` | `rename_preview`：用 LSP rename 生成计划。拒绝资源操作、工作区外文件、只读/非常规/非 UTF-8 文件、重叠或越界编辑，以及需要用户确认的编辑；计划里保存每个文件的 SHA-256 和完整新内容，并列出改完后仍含旧名的行 |
| `rename-plans.ts` | 计划的内存登记：30 分钟有效、只能用一次、绑定 workspace identity；无文件系统依赖，供变更追踪和压缩读取路径 |
| `locate.ts`、`context.ts`、`terms.ts`、`text.ts`、`lexical-definitions.ts`、`failure.ts` | 目标定位（symbol_id / 位置 / 路径+名字，过期 id 按 namePath 重新定位）、按 mtime+size 失效的文件符号缓存、查询词（拆词、词干、同义词、中文词表和二元组）、源码快照、文本回退时的声明识别 |

`apply_rename`（`tools/apply-rename.ts`）复用 `apply_patch` 的文件队列和整体回滚：写入前逐个文件重新校验哈希，任一文件变化则整份计划拒绝、一个字节都不写。

### lexical/

`search.ts`：ripgrep `--json` 搜索与文件列表（UTF-16 列号、工作区相对 POSIX 路径、超时与取消）。workflow 和语义后端的外部文件变更通知都用它；它不是 Symbols 的查询后端。

### store/

`SymbolStore`：`SymbolId` 到符号记录的内存表，带条目上限和过期检查。

### runtime/

| 文件 | 内容 |
| --- | --- |
| `runtime.ts` | `CodeIntelligenceRuntime`：一个 workspace 的 Symbol Store、registry、manager、语义后端和 router 的所有者 |
| `installation.ts` | `CodeIntelligenceInstallationManager`：读取 manifest，按语言下载、校验（大小和 SHA-256）、安装模块，报告状态 |
| `bundled-registry.ts` | 随包/已安装语言服务器的目录与 registry 创建 |
| `configuration.ts` | 由设置中的 `servers` 创建 registry |
| `types.ts` | 运行时状态与服务接口 |

模块安装位置：`%USERPROFILE%\.myharness\agent\code-intelligence\`；语义 workspace 数据在其下按 workspace hash 分目录。正常启动不会下载模块。

### 对外接口

`src/index.ts` 通过 `symbols/api.ts` 和 `symbols/language.ts` 暴露 Symbols 相关公共接口。产品内的使用入口是 `tools/symbols-runtime.ts` 和 `agent/runtime/services.ts`。

### 依赖

- 依赖：`config/settings`、`src/config.ts`、`utils/shell.ts`、`tools/symbols-runtime.ts`（服务接口类型）。
- 被依赖：`tools/symbols.ts`、`tools/symbols-runtime.ts`、`agent/runtime/services.ts`、`modes/web`（安装状态界面）。

## 维护

- 分层不要打穿：`lsp/` 只管通信，`semantic/` 只管语义转换，`router/` 只管选后端，`runtime/` 只管装配。后端不自己创建 `LspClient`，router 不自己创建后端。
- 结果必须带来源和完整度；语义后端不可用时返回明确的不可用/错误，不能假装成功，也不能悄悄用词法结果冒充语义结果（允许的回退仅限 router 文档列出的情况，以及 workflow 层标为 `source=lexical`、`completeness=partial` 的文本回退）。
- workflow 操作只给建议，不拦截任何正常编辑；`rename_preview` 被拒绝时说明原因，不自动重试。
- 不假设机器上装了任何语言服务器。没有大小和 SHA-256 的归档一律拒绝下载。
- 路径处理统一走 `path-semantics.ts`，不要在各处自己拼 URI 或比较路径。
- 本目录和 `tools/symbols-runtime.ts` 之间存在已知的静态循环引用（类型层面），改动时注意不要变成运行时初始化问题。
- 相关测试：`test/code-intelligence/`（lsp、language-server、semantic、router、runtime-manager、集成、`workflow/`）、`symbols-tool-*.test.ts`、`workflow.test.ts`（调查工具侧的 symbols 门控）。真实语言服务器的端到端验证需要已安装的语言模块，静态测试不能替代：`test/code-intelligence/workflow/workflow-lsp-e2e.test.ts` 在设置 `MYHARNESS_SYMBOLS_LSP_E2E=1` 时用本机已安装的服务器跑 TypeScript 全流程和 Python/Go/Rust/PHP/Java/C# 冷启动跨文件检查（未安装的语言跳过，不下载）。
