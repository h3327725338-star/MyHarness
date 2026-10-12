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

`LspSemanticBackend`：文档同步（didOpen/didChange/didClose）、诊断订阅、把协议数据转成统一模型。细节见 [semantic/README.md](semantic/README.md)。

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
- 被依赖：`tools/symbols.ts`、`tools/symbols-runtime.ts`、`agent/runtime/services.ts`、`modes/interactive`（安装状态界面）。

## 维护

- 分层不要打穿：`lsp/` 只管通信，`semantic/` 只管语义转换，`router/` 只管选后端，`runtime/` 只管装配。后端不自己创建 `LspClient`，router 不自己创建后端。
- 结果必须带来源和完整度；语义后端不可用时返回明确的不可用/错误，不能假装成功，也不能悄悄用词法结果冒充语义结果（允许的回退仅限 router 文档列出的情况）。
- 不假设机器上装了任何语言服务器。没有大小和 SHA-256 的归档一律拒绝下载。
- 路径处理统一走 `path-semantics.ts`，不要在各处自己拼 URI 或比较路径。
- 本目录和 `tools/symbols-runtime.ts` 之间存在已知的静态循环引用（类型层面），改动时注意不要变成运行时初始化问题。
- 相关测试：`test/code-intelligence/`（lsp、language-server、semantic、router、runtime-manager、集成）、`symbols-tool-*.test.ts`。真实语言服务器的端到端验证需要已发布的归档，静态测试不能替代。
