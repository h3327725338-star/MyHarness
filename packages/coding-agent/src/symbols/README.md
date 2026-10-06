# symbols/ — Code Intelligence

## 说明

### 职责

为 `symbols` 工具提供代码结构信息：符号、定义、引用、实现、诊断。有两条后端：

- **轻量索引（lightweight）**：源码内实现，按词法解析，默认可用；
- **语义后端（semantic）**：通过 LSP 语言服务器，需要按语言安装的可选 Windows 模块。发布清单与本机已安装模块是不同状态；本机健康安装或显式配置的服务器可以提供语义能力，没有可用服务器时明确返回 unavailable。

`router` 决定一次查询走哪条后端。

### 顶层文件

| 文件 | 内容 |
| --- | --- |
| `types.ts` | 统一数据模型：位置、范围、符号、引用、诊断、各类查询结果及其来源/完整度标记。位置一律 0-based |
| `path-semantics.ts` | 路径契约：一律按 Windows 语义处理 workspace、文档路径和 `file://` URI，大小写不敏感的 identity |
| `symbol-identity.ts` | `namePath` 的构造与解析、`SymbolId` 生成 |
| `legacy-adapter.ts` | 把轻量索引的旧格式 `IndexedCodeSymbol` 转成统一模型 |
| `api.ts` | 本目录的统一出口 |

### index/

| 路径 | 内容 |
| --- | --- |
| `code-index.ts` | `CodeSymbolIndex`：轻量索引本体（扫描、解析、增量刷新、查符号/定义/引用、代码搜索、代码地图） |
| `lightweight/` | `LightweightCodeIntelligenceBackend`：把轻量索引包装成统一模型的后端 |
| `router/` | `CodeIntelligenceRouter`：路由策略（`auto` / `semantic` / `lightweight`）与回退规则。细节见 [router/README.md](index/router/README.md) |

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
| `runtime.ts` | `CodeIntelligenceRuntime`：一个 workspace 的全部组件（索引、store、registry、manager、两个后端、router）的所有者 |
| `installation.ts` | `CodeIntelligenceInstallationManager`：读取 manifest，按语言下载、校验（大小和 SHA-256）、安装模块，报告状态 |
| `bundled-registry.ts` | 随包/已安装语言服务器的目录与 registry 创建 |
| `configuration.ts` | 由设置中的 `servers` 创建 registry |
| `types.ts` | 运行时状态与服务接口 |

模块安装位置：`%USERPROFILE%\.myharness\agent\code-intelligence\`；语义 workspace 数据在其下按 workspace hash 分目录。正常启动不会下载模块。

### 对外接口

`src/index.ts` 导出 `symbols/api.ts` 和 `symbols/index/code-index.ts`。产品内的使用入口是 `tools/symbols-runtime.ts` 和 `agent/runtime/services.ts`。

### 依赖

- 依赖：`config/settings`、`src/config.ts`、`utils/shell.ts`、`tools/symbols-runtime.ts`（服务接口类型）。
- 被依赖：`tools/symbols.ts`、`tools/refactor.ts`、`tools/symbols-runtime.ts`、`agent/runtime/services.ts`、`modes/web/`（安装状态界面）。

## 维护

- 分层不要打穿：`lsp/` 只管通信，`semantic/` 只管语义转换，`router/` 只管选后端，`runtime/` 只管装配。后端不自己创建 `LspClient`，router 不自己创建后端。
- 结果必须带来源和完整度；语义后端不可用时返回明确的不可用/错误，不能假装成功，也不能悄悄用词法结果冒充语义结果（允许的回退仅限 router 文档列出的情况）。
- 不假设机器上装了任何语言服务器。没有大小和 SHA-256 的归档一律拒绝下载。
- 路径处理统一走 `path-semantics.ts`，不要在各处自己拼 URI 或比较路径。
- 本目录和 `tools/symbols-runtime.ts` 之间存在已知的静态循环引用（类型层面），改动时注意不要变成运行时初始化问题。
- 相关测试：`test/code-intelligence/`（lightweight、lsp、language-server、semantic、router、runtime-manager、集成）、`code-index.test.ts`、`symbols-tool-*.test.ts`。真实语言服务器的端到端验证需要健康安装或显式配置的服务器，静态测试不能替代。

### 当前升级能力与边界

- manager 提供只广告已实现行为的客户端 profile；TypeScript startup 关闭 syntax-server fallback，避免工程冷加载时 references/rename 只返回打开文件。
- `inspect_symbol` 提供同对象分面结果、快照绑定分页及缺失能力状态。
- flat/workspace 范围经过名称定位与规范化，不直接冒充 identifier 范围。
- TS 显式 extends/implements adapter 从项目内或 managed runtime 加载编译器；不依赖产品 checkout 的 dev-only hoist。
- `refactor` 只预览标准 rename 或统一补丁，再由 `changes/` 提交。Session 的 edit/write/refactor 共用 ChangeControl。
- 诊断 push 等待为事件驱动；无版本缓存不能满足等待，但这还不是完整 generation/epoch barrier。
- Runtime 将共享索引上的 TS/JS 实际 diff 结构审查接入 Session 的 edit/write/refactor broker。32-token 窗口可发现跨文件、同文件、批内新增重复和向既有函数粘贴；不保证任意 near-miss 或业务等价识别，也尚无用户批准例外流程。
- Diagnostics pull 保留 previousResultId/unchanged，按请求时不可变文本/version 与 session generation 判断失效；标准 pull 不依赖服务器提供 version。relatedDocuments 有协议校验，未同步相关文件明确 partial。Session broker commit 主动同步已打开变更文件并刷新共享索引，项目 generation 使未改 caller 的旧诊断失效。Push 无版本仍 partial；未实现完整依赖 epoch 与项目级屏障，不能据此宣称全项目已验证。
- **尚未完整接入**意图/合同复用检索、影响计划、strict Settings/执行边界、持久 verification debt、项目检查及最终完成门槛。提交成功不代表验证成功。
