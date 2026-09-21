# 项目文档总索引

本文件是 MyHarness 当前 checkout 的文档入口。它把“功能说明”“日常维护”“后续开发”分开，并明确每类内容的事实来源。

## 事实优先级

涉及“现在能做什么”时，按以下顺序判断：

1. 当前 `packages/*/src`、根目录 `package.json`、工作流和配置文件；
2. 实际测试、日志和运行结果；
3. 当前说明文档；
4. `CHANGELOG`、Phase 文档和标记为 historical 的设计记录。

文档不能替代源码或运行时验证。特别是 Provider、模型目录、OAuth、语言服务器、终端行为和外部 API，必须把“源码存在”“配置已加载”“真实运行成功”分开记录。

## 文档地图

| 范围 | 功能说明 | 维护文档 | 后续开发文档 | 事实范围 |
| --- | --- | --- | --- | --- |
| 整个仓库 | [README](README.md)、[架构与开发维护手册](ARCHITECTURE_AND_DEVELOPMENT.md)、[存储与数据边界](docs/STORAGE.md) | [根维护手册](MAINTENANCE.md) | [开发路线与边界](DEVELOPMENT_ROADMAP.md)、[项目状态](PROJECT_STATUS.md)、[ADR](docs/decisions/) | monorepo、脚本、CI、发布、数据生命周期 |
| Coding Agent 产品层 | [产品文档索引](packages/coding-agent/docs/index.md) | [产品维护手册](packages/coding-agent/docs/maintenance.md) | [产品后续开发](packages/coding-agent/docs/roadmap.md) | CLI、AgentSession、Session、Provider runtime、TUI mode |
| Coding Agent 源码模块 | [源码模块地图](packages/coding-agent/docs/source-modules.md) | 同左 | 同左 | `packages/coding-agent/src` 的 24 个一级目录和顶层入口 |
| Agent Core | [Agent Core 文档索引](packages/agent/docs/index.md)、[README](packages/agent/README.md) | [Agent Core 维护](packages/agent/docs/maintenance.md) | [Agent Core 后续开发](packages/agent/docs/roadmap.md) | Agent、agent loop、harness、session contract |
| AI/Provider | [AI 文档索引](packages/ai/docs/index.md)、[README](packages/ai/README.md) | [AI 维护](packages/ai/docs/maintenance.md) | [AI 后续开发](packages/ai/docs/roadmap.md) | Models、Provider、API、auth、OAuth contract |
| TUI | [TUI 文档索引](packages/tui/docs/index.md)、[README](packages/tui/README.md) | [TUI 维护](packages/tui/docs/maintenance.md) | [TUI 后续开发](packages/tui/docs/roadmap.md) | Component、Container、TUI、terminal、differential rendering |
| SQLite Node 存储 | [SQLite 文档索引](packages/storage/sqlite-node/docs/index.md)、[README](packages/storage/sqlite-node/README.md) | [SQLite 维护](packages/storage/sqlite-node/docs/maintenance.md) | [SQLite 后续开发](packages/storage/sqlite-node/docs/roadmap.md) | `node:sqlite`、migration、session repo、materialized state |
| System Prompts | [Prompt 说明](system-prompts/README.md) | [Prompt 维护](system-prompts/maintenance.md) | [Prompt 后续开发](system-prompts/roadmap.md) | 资源文件、加载顺序、替代目录 |
| 项目自动化 | [脚本说明](scripts/README.md)、[Release Gate](docs/RELEASE_GATE.md) | [脚本维护](scripts/maintenance.md) | [脚本后续开发](scripts/roadmap.md) | `scripts/`、`.husky`、隐私与发布审计 |
| CI / GitHub | [GitHub 自动化](docs/maintenance/github-automation.md) | [CI 维护](.github/maintenance.md) | [CI 后续开发](.github/roadmap.md) | workflows、issue gate、audit、binary build |
| 项目配置 | [.myharness 说明](.myharness/README.md) | [配置维护](.myharness/maintenance.md) | [配置后续开发](.myharness/roadmap.md) | 项目级设置和被忽略的运行时数据 |

## 说明、维护、后续开发分别解决什么

- **说明文档**回答使用者“如何安装、配置、调用和理解功能”。
- **维护文档**回答维护者“改哪里、哪些 contract 不能破坏、怎样检查、哪些操作会写文件”。
- **后续开发文档**只记录基于当前源码的候选方向、边界和验收条件，不把推断写成已经承诺的功能或时间表。

并不是每一个私有 helper 都需要一个独立 Markdown 文件；每个可维护的领域都在上表有入口，Coding Agent 的一级源码目录在[源码模块地图](packages/coding-agent/docs/source-modules.md)中逐项覆盖。对单个函数，源码、测试和所属领域维护手册是唯一组合入口。

## 当前必须记住的事实

- MyHarness 自身使用 Apache-2.0；根 `LICENSE` 和 `NOTICE` 只定义项目方有权许可的部分。继承代码和第三方依赖的许可证、版权和 attribution 必须按 `THIRD_PARTY_NOTICES.md` 及其源码位置保留。
- `packages/ai/src/providers/all.ts` 的 Provider、model 和 image catalog 当前为空；`builtinModels()` 只是返回未预配置 Provider 的 collection。它不是默认 Provider 列表。
- Coding Agent 的实际 Provider/Model 来自 `models.json`、Provider credential、模型缓存和 Extension/native Provider registration；环境变量本身不会创建 Provider。
- Agent Core 不内置 SQLite；Node SQLite 实现位于独立的 `packages/storage/sqlite-node`，其测试入口主要在 `packages/agent/test/harness`。
- `npm run check` 会先执行 `biome check --write`，因此它不是只读检查；提交钩子还会重新暂存被格式化的已存在文件。
- `packages/coding-agent/code-intelligence/runtime-manifest.json` 当前是 `published: false`，下载归档的 `sizeBytes` 和 `sha256` 为空；在真实 Release 资产和校验值出现前，语义模块应保持 unavailable。
- `system-prompts/session/commit-authorization.md` 当前不存在；`/commit` 的边界由 Coding Agent 源码中的 Git/Session 流程处理，不能把缺失文件当成可加载 Prompt。
- `packages/coding-agent/docs/architecture-baseline.md`、`phase*-architecture-boundaries.md`、`docs/rpc.md` 等明确标为 historical 的文档只用于理解历史，不作为当前实现说明。

## 修改文档时的最小同步要求

修改以下内容后，至少检查对应文档入口：

| 修改内容 | 必查文档 |
| --- | --- |
| package export、公共类型、Provider/API contract | 对应包的 README、`docs/index.md`、维护手册、架构手册 |
| Agent 生命周期、Session JSONL、migration、持久化 | Agent/Coding Agent 维护手册、session 文档、相关测试 |
| CLI、命令、配置、路径、启动方式 | Coding Agent `usage.md`、`settings.md`、`development.md`、Windows 文档 |
| Prompt 文件或加载顺序 | `system-prompts/README.md`、AI loader、Coding Agent composer |
| 脚本、CI、发布、锁文件 | `scripts/README.md`、`docs/maintenance/github-automation.md`、根 `package.json` |
| License、第三方或继承代码 | `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md`、对应源码 notice |
| 项目阶段和长期决策 | `PROJECT_STATUS.md`、`docs/decisions/` |
| Storage、Session、用户数据和运行时目录 | `docs/STORAGE.md`、架构手册、Coding Agent Session 文档 |

完成修改后，应分别报告静态检查、测试、真实启动和外部服务验证；只做源码/文档审计时，不要写成“运行正常”。
