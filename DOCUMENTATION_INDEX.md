# 项目文档总索引

本文件是 MyHarness 当前 checkout 的文档入口。它把“功能说明”“日常维护”“后续开发”分开，并明确每类内容的事实来源。

## Agent 修改入口

后续 Agent 开发 MyHarness 时，根 `AGENTS.md` 是项目级规则入口和文档路由器；
`DOCUMENTATION_INDEX.md` 是不知道专题位置时使用的文档地图。最小工作顺序是：
先读根 `AGENTS.md`，按任务读取对应专题文档，再核对真实源码、调用方、配置和
测试，修改后同步直接受影响的文档并验证。无需每次无条件读取整个仓库的 Markdown。

常用路由如下：

| 任务 | 入口 |
| --- | --- |
| Git stage / commit / push / 历史写操作 | `docs/maintenance/git-workflow.md` |
| 架构 / 模块边界 | `ARCHITECTURE_AND_DEVELOPMENT.md` |
| 日常维护 | `MAINTENANCE.md` |
| CI / GitHub Actions | `.github/maintenance.md`、`docs/maintenance/github-automation.md` |
| Release / 隐私审计 | `docs/RELEASE_GATE.md` |
| System Prompt | `system-prompts/README.md`、`system-prompts/maintenance.md` |
| Coding Agent | `packages/coding-agent/docs/index.md`、`development.md`、`maintenance.md`、`settings.md` |
| Web UI | `packages/coding-agent/docs/web-ui.md` |
| Agent Core / AI / TUI | 各自 `packages/<package>/docs/index.md` 和 `maintenance.md` |
| 项目配置 / Project Trust | `.myharness/README.md`、`.myharness/maintenance.md`、Coding Agent `settings.md` |

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
| 整个仓库 | [README](README.md)、[中文 README](README.zh-CN.md)、[架构与开发维护手册](ARCHITECTURE_AND_DEVELOPMENT.md)、[存储与数据边界](docs/STORAGE.md) | [根维护手册](MAINTENANCE.md) | [开发路线与边界](DEVELOPMENT_ROADMAP.md)、[项目状态](PROJECT_STATUS.md)、[ADR](docs/decisions/) | monorepo、脚本、CI、发布、数据生命周期 |
| Coding Agent 产品层 | [产品文档索引](packages/coding-agent/docs/index.md)、[中文索引](packages/coding-agent/docs/index.zh-CN.md)、[Web UI](packages/coding-agent/docs/web-ui.md) | [产品维护手册](packages/coding-agent/docs/maintenance.md) | [产品后续开发](packages/coding-agent/docs/roadmap.md) | CLI、AgentSession、Session、Provider runtime、TUI mode |
| Coding Agent 源码模块 | [源码模块地图](packages/coding-agent/docs/source-modules.md)；每个一级目录的 `src/<目录>/README.md`（“说明”一节） | 同一份 `README.md` 的“维护”一节 | 同左 | `packages/coding-agent/src` 的 24 个一级目录（含各自子目录）和顶层入口 |
| 其他包的源码目录 | [agent](packages/agent/src/README.md)、[ai](packages/ai/src/README.md)、[tui](packages/tui/src/README.md)、[sqlite-node](packages/storage/sqlite-node/src/README.md) 的 `src/README.md` | 同一份 `README.md` 的“维护”一节 | 各包 `docs/roadmap.md` | 各包 `src` 下的每个子目录 |
| Agent Core | [Agent Core 文档索引](packages/agent/docs/index.md)、[README](packages/agent/README.md) | [Agent Core 维护](packages/agent/docs/maintenance.md) | [Agent Core 后续开发](packages/agent/docs/roadmap.md) | Agent、agent loop、harness、session contract |
| AI/Provider | [AI 文档索引](packages/ai/docs/index.md)、[README](packages/ai/README.md) | [AI 维护](packages/ai/docs/maintenance.md) | [AI 后续开发](packages/ai/docs/roadmap.md) | Models、Provider、API、auth、OAuth contract |
| TUI | [TUI 文档索引](packages/tui/docs/index.md)、[README](packages/tui/README.md) | [TUI 维护](packages/tui/docs/maintenance.md) | [TUI 后续开发](packages/tui/docs/roadmap.md) | Component、Container、TUI、terminal、differential rendering |
| SQLite Node 存储 | [SQLite 文档索引](packages/storage/sqlite-node/docs/index.md)、[README](packages/storage/sqlite-node/README.md) | [SQLite 维护](packages/storage/sqlite-node/docs/maintenance.md) | [SQLite 后续开发](packages/storage/sqlite-node/docs/roadmap.md) | `node:sqlite`、migration、session repo、materialized state |
| System Prompts | [Prompt 说明](system-prompts/README.md) | [Prompt 维护](system-prompts/maintenance.md) | [Prompt 后续开发](system-prompts/roadmap.md) | 资源文件、加载顺序、替代目录 |
| 项目自动化 | [脚本说明](scripts/README.md)、[Release Gate](docs/RELEASE_GATE.md) | [Git 工作流](docs/maintenance/git-workflow.md)、[脚本维护](scripts/maintenance.md) | [脚本后续开发](scripts/roadmap.md) | Git 写操作、`scripts/`、`.husky`、隐私与发布审计 |
| CI / GitHub | [GitHub 自动化](docs/maintenance/github-automation.md) | [CI 维护](.github/maintenance.md) | [CI 后续开发](.github/roadmap.md) | workflows、issue gate、audit、binary build |
| 项目配置 | [.myharness 说明](.myharness/README.md) | [配置维护](.myharness/maintenance.md) | [配置后续开发](.myharness/roadmap.md) | 项目级设置和被忽略的运行时数据 |

## 说明、维护、后续开发分别解决什么

- **说明文档**回答使用者“如何安装、配置、调用和理解功能”。
- **维护文档**回答维护者“改哪里、哪些 contract 不能破坏、怎样检查、哪些操作会写文件”。
- **后续开发文档**只记录基于当前源码的候选方向、边界和验收条件，不把推断写成已经承诺的功能或时间表。

并不是每一个私有 helper 都需要一个独立 Markdown 文件；每个可维护的领域都在上表有入口，Coding Agent 的一级源码目录在[源码模块地图](packages/coding-agent/docs/source-modules.md)中逐项覆盖，子目录级别的职责、对外接口、依赖和维护规则写在各目录自己的 `README.md` 里（说明和维护合在一个文件中，分两节）。对单个函数，源码、测试和所属领域维护手册是唯一组合入口。

## 当前必须记住的事实

- MyHarness 自身使用 Apache-2.0；根 `LICENSE` 和 `NOTICE` 只定义项目方有权许可的部分。继承代码和第三方依赖的许可证、版权和 attribution 必须按 `THIRD_PARTY_NOTICES.md` 及其源码位置保留。
- `packages/ai/src/providers/all.ts` 的 Provider、model 和 image catalog 当前为空；`builtinModels()` 只是返回未预配置 Provider 的 collection。它不是默认 Provider 列表。
- Coding Agent 的实际 Provider/Model 来自 `models.json`、Provider credential、模型缓存和 Extension/native Provider registration；环境变量本身不会创建 Provider。
- Agent Core 不内置 SQLite；Node SQLite 实现位于独立的 `packages/storage/sqlite-node`，其测试入口主要在 `packages/agent/test/harness`。
- `npm run check` 会先执行 `biome check --write`，因此它不是只读检查；提交钩子还会重新暂存被格式化的已存在文件。
- 正式 GitHub CI 由 `.github/workflows/ci.yml` 的 `windows-2022` + `windows-2025` matrix 构成；两套 runner 执行相同完整流程且都必须通过，不使用 `windows-latest`。
- CI baseline 是 GitHub Windows Server 自动化环境，不等同于最终用户平台支持矩阵。MyHarness 面向 Windows 桌面 x64；当前仓库没有据此逐一验证 Windows 10/11 的每个桌面版本。
- 根 `AGENTS.md` 是本仓库 Agent 开发规则入口；产品运行时的 `system-prompts/` 是另一层、面向所有 MyHarness 项目的静态 System Prompt 资源。二者不能互相替代。
- `packages/coding-agent/code-intelligence/runtime-manifest.json` 当前是 `published: false`，下载归档的 `sizeBytes` 和 `sha256` 为空；在真实 Release 资产和校验值出现前，语义模块应保持 unavailable。
- `system-prompts/session/commit-authorization.md` 当前不存在；`/commit` 的边界由 Coding Agent 源码中的 Git/Session 流程处理，不能把缺失文件当成可加载 Prompt。
- `packages/coding-agent/docs/architecture-baseline.md`、`phase*-architecture-boundaries.md`、`docs/rpc.md` 等明确标为 historical 的文档只用于理解历史，不作为当前实现说明。

## 修改文档时的最小同步要求

修改以下内容后，至少检查对应文档入口：

| 修改内容 | 必查文档 |
| --- | --- |
| Agent 项目规则、文档路由或开发入口 | `AGENTS.md`、`DOCUMENTATION_INDEX.md`、对应专题维护手册 |
| package export、公共类型、Provider/API contract | 对应包的 README、`docs/index.md`、维护手册、架构手册 |
| Agent 生命周期、Session JSONL、migration、持久化 | Agent/Coding Agent 维护手册、session 文档、相关测试 |
| CLI、命令、配置、路径、启动方式 | Coding Agent `usage.md`、`settings.md`、`development.md`、Windows 文档 |
| Prompt 文件或加载顺序 | `system-prompts/README.md`、AI loader、Coding Agent composer |
| 脚本、CI、发布、锁文件 | `scripts/README.md`、`docs/maintenance/github-automation.md`、根 `package.json` |
| License、第三方或继承代码 | `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md`、对应源码 notice |
| 项目阶段和长期决策 | `PROJECT_STATUS.md`、`docs/decisions/` |
| Storage、Session、用户数据和运行时目录 | `docs/STORAGE.md`、架构手册、Coding Agent Session 文档 |

完成修改后，应分别报告静态检查、测试、真实启动和外部服务验证；只做源码/文档审计时，不要写成“运行正常”。
