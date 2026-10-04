# MyHarness 项目架构与开发维护手册

本文描述当前源码边界，不是历史 Phase 记录。修改入口为根 `AGENTS.md`；专题导航见 `DOCUMENTATION_INDEX.md`，维护与验证见 `MAINTENANCE.md`。

## 产品与平台

MyHarness 是 npm / TypeScript / ESM monorepo，面向 Windows 桌面 x64。用户交互只通过本机浏览器 Web UI。旧终端聊天、print、JSON 输出、RPC、TUI 包和终端组件 API 均不属于当前产品。

正式 GitHub CI 使用 `windows-2022` 和 `windows-2025` matrix；两边执行相同验证且必须通过。它们是 CI runner，不是最终用户桌面支持矩阵，不代表逐一验证 Windows 10/11 的每个版本。

项目采用 Apache-2.0；继承代码与第三方组件 attribution 见 `LICENSE`、`NOTICE` 和 `THIRD_PARTY_NOTICES.md`。

## Package 边界

| Package | 职责 | 公共入口 |
| --- | --- | --- |
| `packages/ai` | Provider、模型、认证、API adapter、流式消息和 usage | `src/index.ts` 及 manifest subpath |
| `packages/agent` | Provider 无关的 Agent loop、工具队列、通用 Session 与 Harness contract | `src/index.ts`、`./node` |
| `packages/storage/sqlite-node` | 通用存储 contract 的 Node SQLite backend 和 migration | `src/index.ts` |
| `packages/coding-agent` | 产品编排、Web、Session、Settings、Trust、资源、Provider runtime、工具、Git、扩展 | `src/index.ts`；进程入口 `src/web.ts` |

依赖方向：`coding-agent → agent → ai`；产品层也直接依赖 ai 和 storage。不存在 `packages/tui` workspace。底层业务不得依赖浏览器页面或终端展示组件。

## 启动与运行时

```text
dev-web.cmd → dev-web.vbs → dev-web.ps1 → web-runtime.ps1
                                               │
                               node + scripts/dev-fast-loader.mjs
                               或 web-source.ps1 → tsx
                                               │
                                  coding-agent/src/web.ts
                                               │
                                             main.ts
                                               │
                           startWebBootstrap → AgentSessionRuntime
                                               │
                                       runWebMode / WebHost
                                               │
                         loopback HTTP + SSE → coding-agent/web/
```

- `dev-web.cmd` 是唯一双击开发入口，后台启动；`--console` 用于查看服务日志，不是终端聊天模式。
- `web-runtime.ps1` 检查 Node/npm/tsx/bash/ffmpeg，并在必要时准备依赖。从脚本位置定位仓库。
- `web-source.ps1` / `web-source.sh` 直接运行 `src/web.ts`，保留调用者工作目录；`--no-env` 清理当前进程的 Provider 环境变量。
- npm `myharness` 指向 `dist/web.js`；它是 Web 服务启动命令，不提供第二套交互。
- Bun 编译入口为 `src/bun/web.ts`，保留 OAuth、sandbox 环境恢复与 Bedrock 注册。
- `src/web.ts` 也分发内部 `--internal-delegated-worker`。Explore 使用内部 NDJSON 协议，不能将它当作公开 JSON 输出模式。
- `main.ts` 装配 Settings、Trust、ResourceLoader、SessionManager、模型与代码智能，然后创建 `AgentSessionRuntime` / `AgentSession`。启动信任询问通过浏览器处理。
- Web 在慢初始化前监听 loopback；页面可显示启动状态。服务生命周期、重启、旧实例退出及日志规则以 [Web UI](packages/coding-agent/docs/web-ui.md) 为准。

## 产品源码归属

| 路径 | 职责 |
| --- | --- |
| `startup/` | Web 启动参数、帮助、文件与初始消息输入、浏览器命令和设置表 |
| `agent/runtime/` | Agent 生命周期、运行时服务与 SDK、会话桥 |
| `agent/delegation/` | 内部委托 worker、事件解析 |
| `session/` | Session 格式、JSONL、投影、持久化、锁与 migration |
| `context/` | 上下文预算与压缩 |
| `config/` | Settings、路径、Trust 与兼容迁移 |
| `application/` | 资源加载、Trust、Workspace 及跨领域 use case |
| `providers/` | 产品 Provider runtime、模型与 credential |
| `tools/` | 工具执行 contract、权限、取消和结果 |
| `extensions/` | contracts、API entry、loader、runtime 与包管理 |
| `git/` | Git 原语、checkpoint、Worktree 和提交/推送流程 |
| `symbols/` | 代码索引、语义查询、语言服务器与模块安装 |
| `system-prompts/` | 产品 prompt 组合与 loader；静态资源在仓库根同名目录 |
| `modes/web/` | HTTP/SSE、WebHost、页面交互桥接与真实 Shell Terminal |
| `exports/` | HTML / JSONL 数据导出，不是终端输出模式 |
| `platform/` | HTTP dispatcher 与进程执行等平台能力 |
| `web/`（package 根） | 浏览器页面、样式、前端状态和交互 |

没有 `src/core/`、`frontend/`、`shared/` 或 `application/bootstrap/`。不要创建承载任意业务的万能目录。

## 公共 contract 与兼容

- 正式 import/export 以各 package manifest 和 `src/index.ts` 为准。源码内部路径不是新的公共 API。
- `Args` / `parseArgs` 与斜杠命令公开导出保留，其实现移动到 `startup/`。不再解析旧终端输出参数或多界面切换参数。
- Extension host 只有 `web` 与 `headless`（SDK/worker，无浏览器 UI）；用 `hasUI` 判断实际对话框能力。
- 不提供终端输入 handler、TUI component、Theme renderer、custom editor/overlay factories 或 Tool terminal render callbacks。Web dialogs、纯文本 widgets、消息/entry 文本 renderer、工具执行和业务事件保留。
- Session JSONL、Settings、credentials、resource loader 的旧持久化兼容仍保留。不要删除用户 Theme 文件、终端历史设置或旧格式数据来达到“无 CLI”目标；这些兼容不意味着仍有终端前端。
- `MYHARNESS_PROCESS_ENTRY` 用于显式指定子进程入口，旧 `MYHARNESS_CLI_ENTRY` 仅作为环境变量兼容回退。
- Web Terminal 使用 `WebTerminals`、node-pty、xterm；它是页面里的独立 Shell，必须保留。

## Provider、资源与数据

`ModelRuntime.create()` 不自动加载上游 Provider/model catalog。产品 Provider 来自用户 `models.json` 或明确注册的扩展；启动器不同步模型目录。API adapter 的存在不代表产品已注册对应 Provider。

项目 Trust 控制项目配置与扩展。受信任项目 `.myharness/SYSTEM.md` 覆盖全局 `SYSTEM.md`，不受信任则回退全局；`APPEND_SYSTEM.md` 使用相同优先级，不简单合并两边。`AGENTS.md` / `CLAUDE.md` 是独立项目上下文，除非显式关闭，否则不因 Trust 被跳过。

根 `system-prompts/` 面向所有产品用户，不承载仓库自身 CI 与维护规则。仓库开发约定只放根 `AGENTS.md` 及其路由文档。

Session、cache、trace、credential、memory、Workspace 和代码智能运行时不属于源码清理范围。存储路径与数据安全见 `docs/STORAGE.md`；不可为了清理入口删除运行时数据。

## 修改与验证

修改前确认实际定义、引用、调用方、配置来源与测试；复用现有能力，保留未提交改动。跨领域流程用 application use case，不把业务状态机塞入页面或 utils。不得破坏取消、恢复、错误处理、权限与持久化语义。

改变启动路径、Public API、配置、Extension contract、Prompt 或数据格式时同步直接相关文档。历史 Phase 和 changelog 仅记录历史，不应改写为当前事实。

按范围执行只读类型检查、相关测试、构建与真实隔离启动。`npm run check` 包含 Biome `--write`，不是只读检查。构建只写明确的产物目录，不使用大范围清理覆盖用户工作。外部 Provider、用户桌面平台与真实运行测试须分别报告，不能用静态检查替代。

Git 写操作必须先读 `docs/maintenance/git-workflow.md`，提交、推送、发布需要当前授权。发布与隐私审计见 `docs/RELEASE_GATE.md`，不得输出凭据或复制私有 Session 数据。
