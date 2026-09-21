# Coding Agent 源码模块地图

本文件按当前 `packages/coding-agent/src` 的实际一级目录整理。它不是旧 Phase 目录的复刻；源码、`package.json` exports 和测试变化后，应重新核对本表。

## 顶层入口

| 路径 | 当前职责 |
| --- | --- |
| `src/cli.ts` | 进程入口、环境标志、HTTP dispatcher 和 `main()` 调用 |
| `src/main.ts` | 参数解析后的启动装配：Settings、Trust、ResourceLoader、ModelRuntime、SessionManager、AgentSession、Interactive/Print mode |
| `src/index.ts` | package public exports：SDK、Session、Provider、Tool、Extension、CLI 类型等 |
| `src/config.ts` | Coding Agent 配置路径的兼容入口 |
| `src/migrations.ts` | 产品层 data/workspace migration 入口 |
| `src/package-manager-cli.ts` | MyHarness package 管理 CLI |

## 一级目录

| 目录 | 当前源码职责 | 修改时保持的边界 | 后续代码应放在哪里 |
| --- | --- | --- | --- |
| `agent/` | `AgentSession` 生命周期、runtime/sdk、delegation、vision | 复用 AgentSession/runtime；不把 TUI I/O 放进 Agent runtime | session lifecycle、后台 Explore、delegation/vision |
| `application/` | 跨领域 use-case、`ResourceLoader`、WorkspaceStore facade；`git-push.ts` 编排显式 Push、remote 验证和 CI 验收 | 只编排领域模块；持久化实现留在 `data/`/`session/`；不把 Push 细节塞进 TUI | 跨 Git/Provider/Session/Workspace 的流程 |
| `bun/` | Bun CLI、Bedrock 注册、sandbox 恢复 | Bun-specific 适配不反向污染普通 Node CLI | Bun 编译和运行时兼容 |
| `cli/` | 参数、帮助、文件参数、trust、startup UI、model/config selector、slash commands | 解析和展示后调用 domain/runtime；不复制业务 | CLI flag、命令入口和 CLI 错误呈现 |
| `config/` | paths、SettingsManager、settings storage/migration、Project Trust | 配置格式、路径和信任语义集中管理 | settings、paths、trust、config migration |
| `context/` | context item、budget/window/policy、project context、diff/presentation、compaction | 压缩和过滤独立于具体 TUI；遵守 Agent role policy | 新上下文来源、预算和压缩策略 |
| `data/` | Workspace registry/persistence/migration 的实际实现 | Workspace identity 不由 Session manager 重写 | workspace 数据格式和 migration |
| `exports/` | Session/tool 结果到 HTML 的导出、主题和 ToolHtmlRenderer | 只渲染/导出，不改变 Session 或 tool execution contract | 新导出格式 |
| `extensions/` | Extension contract、兼容入口、发现/loader、packages、event bus、runner/wrapper | 通过 contracts/API entry/runtime wrapper 连接；避免 loader 循环依赖 | extension API、加载、包管理和 runtime |
| `git/` | Git command、repository/workspace changes、checkpoint、commit、local repository、worktree，以及 GitHub Actions CI 查询适配 | Git metadata、remote/CI 原语集中在本域；不放进 Session persistence | 新 Git 原语、remote/CI provider、review、checkpoint、worktree |
| `modes/` | InteractiveMode、print mode、组件编排、theme、task lifecycle、keybindings、model search | mode 负责 I/O；通用业务留在领域模块 | 新运行模式或 mode-specific presentation |
| `observability/` | timing、usage totals、cache stats、runtime trace、diagnostic sanitization | 只观察和脱敏，不反向承载业务状态 | 指标、trace 和诊断采集 |
| `platform/` | process exec、HTTP dispatcher、stdout/output guard | 平台差异留在 platform；CLI/tool 不复制进程接管逻辑 | Node/Windows/Bun process 适配 |
| `prompts/` | 用户/项目 prompt templates 的发现、frontmatter、去重和 diagnostics | 与固定 system prompt 分离；保留 sourceInfo/diagnostics | prompt template loader/parser |
| `providers/` | credentials、model config/registry、model store、recovery、`ModelRuntime` | credential 脱敏；Provider runtime 不下沉到 CLI/TUI | Provider/model/credential/recovery |
| `session/` | Session 类型、JSONL storage、projection、manager、migration | Session schema/version/migration/容错集中管理；UI 不直接写文件 | Session schema、storage、projection、migration |
| `skills/` | SKILL.md 发现、frontmatter、ignore、sourceInfo、diagnostics | 遵守 Trust/ResourceLoader；只负责发现解析 | skill loader、collision 和排序 |
| `symbols/` | lightweight index、router、legacy adapter、LSP、semantic backend、language server、store、runtime | 保持 protocol、semantic、index/router、store 分层；以 `api.ts` 为出口。当前默认可用路径是 lightweight；`runtime-manifest.json` 为 `published: false` 时，源码中的 semantic backend 不等于可下载 runtime | 新 code-intelligence backend/adapter |
| `system-prompts/` | AI prompt loader 边界和 Coding Agent composer；组合 role/context/skills/tools | 固定文本在仓库资源，组合在 composer，项目资源走 loader | system prompt 内容/loader/composer |
| `themes/` | ThemeResource loader、global/project/explicit theme paths、diagnostics | loader 不依赖 Interactive Theme class；interactive 状态留在 modes | theme schema、发现和校验 |
| `tools/` | tool contracts、files、shell、GitHub、symbols、sub-agent、result persistence、registry、presentation | execution contract 与 presentation 分离；工具不依赖具体 TUI | 新工具、schema、renderer 和 result persistence |
| `ultracode/` | workflow/ultracode investigation profile、prompt snippet、guidelines | profile 描述调查策略，不直接执行 workflow | 新调查 profile |
| `utils/` | atomic write、path、shell/git command、JSON/frontmatter、image/file、clipboard、highlight 等基础能力 | 只放跨领域基础逻辑，不用 utils 绕开领域边界 | 真正无领域归属的 helper |
| `workflow/` | read-only investigation workflow schema/engine、phase orchestration、result persistence 连接 | workflow task/phase 保持只读约束；工具执行与展示分离 | 编排阶段和 workflow contract |

## 关键连接

```text
cli.ts
  -> main.ts
  -> application/ResourceLoader + config/Trust + providers/ModelRuntime
  -> session/SessionManager + agent/AgentSession
  -> modes/interactive 或 print mode
  -> tools / prompts / skills / themes / extensions
```

Provider 的请求路径是 `AgentSession`/SDK → `ModelRuntime` → `@myharness/ai` Models/Provider → API implementation。Session 的产品层路径是 SessionManager/JSONL；SQLite backend 是独立 package，不能从这张图推断产品默认已接入 SQLite。

## 维护证据入口

- 总体边界：[根架构与开发维护手册](../../../ARCHITECTURE_AND_DEVELOPMENT.md)。
- 产品入口：[docs/index.md](index.md)。
- 测试：[package `test/`](../test/)。
- 公共出口：[src/index.ts](../src/index.ts)。
- 各目录的实际 import/export 和调用关系优先于本表的文字摘要。
