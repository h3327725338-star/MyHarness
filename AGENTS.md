# MyHarness Agent Rules

## 项目事实

- 这是一个 npm/TypeScript/ESM monorepo。
- 产品层在 packages/coding-agent/；Agent Core 在 packages/agent/；Provider/AI API 在 packages/ai/；TUI 基础能力在 packages/tui/。
- 当前整体架构和模块归属见 ARCHITECTURE_AND_DEVELOPMENT.md。
- 当前源码没有 packages/coding-agent/src/core/、frontend/、shared/ 或 application/bootstrap/。

## Agent 开发入口与文档路由

本文件是 Agent 修改 MyHarness 仓库时的项目级权威入口和路由器。它不是
`system-prompts/` 中面向所有 MyHarness 用户的产品运行时 System Prompt；也不要
把仓库自己的 CI、维护流程或开发细节复制到 `system-prompts/`。如果 MyHarness
从本仓库根目录或子目录启动，产品的 project context loader 也会把适用的
`AGENTS.md`/`CLAUDE.md` 作为项目上下文加载，这是运行时输入，与本文件作为
仓库开发入口的职责要区分。

每项任务按以下顺序处理：

1. 先读本文件；
2. 根据任务范围读取下表对应的专题文档，不要求无条件遍历整个仓库的 Markdown；
3. 再检查真实源码、调用方、`package.json`、配置和测试；
4. 修改后同步直接受影响的文档，并执行与范围相称的真实验证。

| 任务范围 | 先读的专题入口 |
| --- | --- |
| 不知道相关文档在哪 | `DOCUMENTATION_INDEX.md` |
| Git 写操作、提交与推送 | `docs/maintenance/git-workflow.md` |
| 整体架构、模块边界、Public API | `ARCHITECTURE_AND_DEVELOPMENT.md` |
| 日常维护、构建和验证 | `MAINTENANCE.md` |
| CI / GitHub Actions | `.github/maintenance.md`、`docs/maintenance/github-automation.md` |
| Release / 隐私 / 公开树审计 | `docs/RELEASE_GATE.md` |
| System Prompt 资源、加载和维护 | `system-prompts/README.md`、`system-prompts/maintenance.md` |
| Coding Agent 产品层 | `packages/coding-agent/docs/index.md` 及其 `development.md`、`maintenance.md`、`settings.md` |
| Agent Core | `packages/agent/docs/index.md`、`packages/agent/docs/maintenance.md` |
| Provider / AI API | `packages/ai/docs/index.md`、`packages/ai/docs/maintenance.md` |
| TUI | `packages/tui/docs/index.md`、`packages/tui/docs/maintenance.md` |
| 项目配置和 Project Trust | `.myharness/README.md`、`.myharness/maintenance.md`、Coding Agent `settings.md` |

## Git 写操作路由

准备执行以下任一 Git 写操作前，必须先读取
[`docs/maintenance/git-workflow.md`](docs/maintenance/git-workflow.md)：

- `git add`、stage/unstage、commit/amend、merge/rebase、tag、push/force push；
- 修改 remote/upstream，删除或修改远端 branch；
- 其他会改变 Git 历史、index、ref 或远端状态的操作。

普通源码阅读和只读 Git 查询不要求读取该专题。

## CI baseline 与用户平台

正式的 `.github/workflows/ci.yml` 只使用两个 GitHub-hosted Windows x64 runner：
`windows-2022` 和 `windows-2025`。它们通过 matrix 对每次正常 CI 触发分别执行
相同的安装、release/privacy audit、`ffmpeg-static` rebuild、build、check、搜索
工具安装和 test 流程；两边都必须通过。不得改回 `windows-latest`，也不要为这项
基线新增 Linux/macOS CI。

这是 GitHub CI baseline，不是最终用户支持矩阵。MyHarness 的用户平台是 Windows
桌面 x64；不能把 GitHub Windows Server runner 写成“只支持 Windows Server”，也
不能仅凭这两个 runner 声称已经逐一验证 Windows 10 或 Windows 11 的每个桌面版本。

机器可检查的约束应由 workflow、脚本和测试执行；本文件及其他 Prompt 只负责说明
项目规则和路由，不能替代这些检查。

## 修改前

- 先读取目标模块的真实源码、调用方、package.json、测试和相关文档。
- 不根据目录名、旧 Phase 文档或经验猜测职责；先确认真实 import/export。
- 任务涉及架构边界、Public API、Session、Settings、Provider、Extension、Prompt 或持久化时，先阅读 ARCHITECTURE_AND_DEVELOPMENT.md 的对应章节。
- 查找已有实现并优先复用；功能有明确领域时放入已有领域目录。

## System Prompt 与项目规则边界

- 根 `system-prompts/` 是 MyHarness 产品运行时使用的静态 System Prompt 资源，面向所有使用 MyHarness 的项目。
- MyHarness 仓库自己的开发规则、CI 版本固定和维护流程只放在根 `AGENTS.md` 及其路由到的仓库文档中。
- 用户/项目的 `SYSTEM.md`、`APPEND_SYSTEM.md`、`AGENTS.md`、`CLAUDE.md` 和 skills 由 Coding Agent 各自的 loader 处理，不要建立第二套项目规则系统。
- 当前实现中，受信任项目的 `.myharness/SYSTEM.md` 覆盖全局 `SYSTEM.md`；不受信任时回退全局文件。`APPEND_SYSTEM.md` 使用同样的项目优先级并作为追加内容，不与全局和项目文件简单合并。`AGENTS.md`/`CLAUDE.md` 是独立的项目上下文，除非显式关闭 context loading，否则不因 Project Trust 被跳过。

## 修改规则

- 只修改完成当前任务所必须的内容，不顺手重构无关区域。
- 不创建承载任意业务的万能目录，也不把业务逻辑塞进 utils/ 或具体 TUI component。
- Agent 生命周期放 agent/runtime/；Session 格式和 persistence 放 session/；Context/Compact 放 context/；Git 原语放 git/；Provider runtime、Model 和 credential 放 providers/；Tool 放 tools/；Extension 放 extensions/。
- 产品页面放 coding-agent 的 modes/interactive/；可复用终端基础组件放 packages/tui/。
- Tool execution contract 与 presentation 分开；底层业务逻辑不要依赖具体 TUI 展示。
- Application use case 用于跨领域业务流程，不用于替代底层领域模块，也不导入具体 TUI。
- 通过正式 contract、runtime 或 API entry 连接模块，不要为了方便直接依赖不稳定的内部实现。
- 不为了减少代码量破坏已有抽象、错误处理、取消、恢复或持久化语义。
- 不重复实现已经存在的能力。

## 兼容性和安全

- 修改前检查 Public API、package.json exports、src/index.ts、Session JSONL、Settings、Credentials、migration、Extension API、Git metadata 和 Prompt 行为。
- 不因为名称旧就删除 compat、deprecated alias、旧 Session/Settings 格式或 migration。
- 不输出 API Key、OAuth Token、Credential、Cookie、Session 私密内容或用户目录中的敏感数据。
- 非必要不要删除或覆盖 Session、Git metadata、用户配置、cache、Trace 或其他持久化数据。

## 文档同步

如果修改改变了架构、模块职责、路径、Public API、配置、命令、Provider、Session format、Extension contract、Prompt 加载或启动方式，必须同步相关专题文档，并在确实影响整体结构或长期规则时同步 ARCHITECTURE_AND_DEVELOPMENT.md。

普通内部 bugfix 不需要为了形式修改总手册。

## 验证

- 根据修改范围运行最相关测试；不要把未实际运行的命令写成已通过。
- 区分静态检查、单元/集成测试、真实启动、外部 Provider 和机器环境验证。
- npm run check 含 Biome --write，不能把它当作只读检查。
- 构建、lockfile、Session、配置、Git 和用户目录写入都要明确确认影响范围。
- 测试失败时先判断是代码失败、环境失败还是外部服务失败，不要随意修改无关代码。
