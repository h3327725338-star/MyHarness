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
| `impact-coverage.ts` | strict runtime 的真实语义引用/调用/实现/类型关系门禁，复用 inspect 分页；查询证据由 ChangeControl 绑定预览并持久化，缺覆盖拒绝，不证明业务根因 |
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

模块安装位置：`%USERPROFILE%\.myharness\agent\code-intelligence\`；语义 workspace 数据在其下按 workspace hash 分目录。正常启动不会下载模块。安装状态和 managed registry 同时检查模块及其 shared runtime 的健康标记；共享组件丢失时显示 repair-needed，不把只有服务器文件的安装当作可运行。健康标记仍不等于真实进程/编译验收。

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

- Vue launcher 将脚本 definition/references/hover/prepareRename/rename 和 pull semantic diagnostics 转发到同一 plugin-enabled tsserver，转换 1-based UTF-16 协议位置为 LSP，并保留 rename prefix/suffix。超时、取消和 server 错误明确返回失败。维护测试覆盖未打开 TS consumer、同名不同对象、实际 rename、独立 TS 编译及 Vue 参数类型错误注入；不据此宣称 template、调用/类型关系或全项目诊断已验收。
- managed Svelte 跨语言 definition 的 TS 目标规范化复用现有 target-language routing（与 Vue 同一路径）；原先用只支持 Svelte 的服务查询 TS 目标导致 definition 空/partial。维护测试实际断言 TS 定义路径、组件 import alias 受控改名且 TS export 不变，并用已安装 Svelte 4 compiler 独立检测 markup 错误和恢复。样例 script 无 TS-only 语法，compiler 检查前移除 lang="ts" 标记，不是完整 TS preprocessing/typecheck 或全项目导出改名验收。
- managed Shell 的真实跨文件探测发现未打开 source consumer 被 references/rename 遗漏；显式 profile 将结果标记 partial，refactor 不存储部分 rename 预览。维护测试复用隔离 fixture，独立 Bash 验证正确调用、下游故障和恢复；尚未实现完整 Shell source/动态调用 adapter。
- JSON/YAML 维护测试真实检测语法错误并独立解析；YAML anchor/alias 实际受控 rename 后值保持相同。已安装 YAML 不支持 references，anchor definition 的对象规范化仍 partial；无版本 push 诊断仍 partial，不能据此认证全项目新鲜度。
- managed Go 的未打开文档 rename version 0 在显式 profile 下转为磁盘编辑；已打开文档和非零 version 保留严格版本检查，实际 token/base hash 检查不关闭。维护测试覆盖未打开调用方、同名对象、实际 rename、私有 Go 离线测试和错误注入/恢复。
- JavaScript 维护测试覆盖未打开 import alias/re-export、同名无关对象、实际受控 rename，以及独立 Node 行为/错误注入/恢复；不据此认证全部项目关系。XML 维护测试覆盖 server mismatched-tag 检测和独立 System.Xml 解析正/负/恢复；DTD 禁止，schema/跨文件未验收，versionless diagnostics 保持 partial。
- Python 维护测试覆盖未打开 import alias、实际 rename、独立解释器运行和注错/恢复；冷启动需要等待项目索引，当前未实现通用 readiness barrier。
- managed Rust 根目录存在 Cargo.toml 时，manager 在 initialized 后显式配置 linkedProjects；这解决已安装 rust-analyzer 仅返回语法符号而未加载根项目的实测问题，不证明嵌套 Cargo 项目或全部工具链健康。
- manager 提供只广告已实现行为的客户端 profile；TypeScript startup 关闭 syntax-server fallback，避免工程冷加载时 references/rename 只返回打开文件。
- `inspect_symbol` 提供同对象分面结果、快照绑定分页及缺失能力状态。
- flat/workspace 范围经过名称定位与规范化，不直接冒充 identifier 范围。
- TS 显式 extends/implements adapter 从项目内或 managed runtime 加载编译器；不依赖产品 checkout 的 dev-only hoist。缓存绑定实际源码/已加载依赖内容 hash、有效 compiler options、references 和根文件集合，不再依赖总字节数/最大 mtime。维护测试覆盖保持 mtime 的同大小下游修改，以及 tsconfig 排除消费者后恢复；尚不覆盖所有新出现依赖或并发解析窗口。
- `refactor` 预览标准 rename、统一补丁或正式 edit-only LSP refactor（`preview_server_refactor`），再由 `changes/` 提交。后者复用现有 synchronized session 和 codeAction/resolve，要求精确唯一标题与有效 refactor kind，绑定请求时不可变文本/version/project generation，拒绝规划中目标或受通知项目变化；拒绝 command/interactive/disabled action（含 resolve 后新增 command）；未广告 applyEdit。Mock 覆盖 edit/resolve/command/ambiguity/disabled，共用 executor 覆盖用户二次编辑冲突。managed TypeScript 的 arrow braces action 有专门只读 compiler adapter：仅发送 getEditsForRefactor，拒绝跨文件/新文件/附加命令，不执行 _typescript.applyRefactoring。其他 command 仍拒绝。真实 TS 当前 Move-to-new-file action 是 command，已实测拒绝且文件不变；真实 arrow adapter 已完成受控 preview/apply 和独立 tsc 编译；维护测试覆盖未打开消费者故障注入/恢复。这不等于全语言 edit-only 或参数/API 联动完成，因此不能宣称 C 完成。Session 的 edit/write/refactor 共用 ChangeControl。
- 诊断 push 等待为事件驱动；无版本缓存不能满足等待，但这还不是完整 generation/epoch barrier。
- Runtime 将共享索引上的 TS/JS 实际 diff 结构审查接入 Session 的 edit/write/refactor broker。32-token 窗口可发现跨文件、同文件、批内新增重复和向既有函数粘贴；不保证任意 near-miss 或业务等价识别。完整 TS/JS 结构候选可通过已有 host ApprovalPort 请求用户批准不能复用的例外，绑定真实扫描 hash 和精确预览，取消/过期/变化失效，批准后再次检查；缺覆盖不能获得该例外。意图/输入输出/行为检索和结构化合同对照尚未完成。
- Diagnostics pull 保留 previousResultId/unchanged，按请求时不可变文本/version 与 session generation 判断失效；标准 pull 不依赖服务器提供 version。返回前重读目标磁盘文本，并发外部改动使结果 partial，而不是继续认证旧快照。relatedDocuments 有协议校验，未同步相关文件明确 partial。Session broker commit 主动同步已打开变更文件并刷新共享索引，项目 generation 使未改 caller 的旧诊断失效。Push 无版本仍 partial；未实现完整依赖 epoch 与项目级屏障，不能据此宣称全项目已验证。
- Session 已接入 changeControl Settings、持久 verification debt、用户配置的项目检查和最终完成门槛；缺检查/缺覆盖不会按成功结束。strict 拒绝非受控 Agent 工具（并非 OS sandbox），失败后的自动修复最多三轮且限制原变更文件。**尚未完整接入**意图/合同复用检索、完整根因/影响核实（已接入计划 hash 与运行时关系查询门禁，但动态/外部及完整反向项目尚有缺口）、旧错误逐项归因及全语言真实验收。提交成功仍不代表验证成功。
