# Phase 0：MyHarness 架构重构不可变基线

本文是正式架构重构前的兼容性基线。它记录当前仓库真实源码、现有测试和已执行的安全验证，不是后续阶段的实现计划。后续修改必须先以源码和测试重新核对本文；如果实现与本文不一致，应先判断是有意变更还是回归。

## 快照信息

- 仓库：`C:/myharness`
- 开始 Phase 0 前的分支：`main`
- 开始 Phase 0 前的 commit：`6adc973694053e4060ccde3243e9071ddcfaa8b8`
- 开始 Phase 0 前的 Git 工作区：干净
- 运行时：Node.js `v22.19.0`、npm `10.9.3`、Bun `1.3.14`、Git `2.55.0.windows.3`
- 本阶段只增加基线文档、兼容性静态守护测试和文档索引链接；不修改生产源码、目录结构、持久化格式或用户交互。

证据标记：

- **源码确认**：由当前仓库源代码、package.json 或启动脚本直接确认。
- **测试确认**：由实际执行的自动测试确认。
- **运行时确认**：实际启动或运行命令得到的结果；不能用静态源码替代。
- **未确认**：本阶段没有声称已经验证的外部服务、真实模型请求、编译后二进制启动或交互式 TUI 行为。

## 1. 公共包 API、CLI 和运行入口

### 包级公共契约（源码确认）

发布包是 `@myharness/coding-agent`：

- CLI：`myharness -> dist/cli.js`
- Node 入口：`dist/index.js`
- TypeScript 声明：`dist/index.d.ts`
- package export `.` 同时提供上述 import 和 types 入口。
- 源码公共 facade 是 `packages/coding-agent/src/index.ts`。它当前覆盖：
  - Args、配置路径、版本和文档路径；
  - `AgentSession`、`SessionManager`、session entry 类型和迁移函数；
  - `SettingsManager`、认证读取、Provider/Model registry、`ModelRuntime`；
  - compaction、context items、event bus、skills、slash commands；
  - Extension 类型、`ExtensionRunner`、extension discovery/runtime、tool 定义和结果判断；
  - SDK：`createAgentSession`、`AgentSessionRuntime` 和各类 tool factory；
  - file diff/presentation、Git/local repository、workspace/trust、package/resource loader；
  - `main`、`InteractiveMode`、print mode、UI component、theme 和 shell/clipboard 工具。

这里的 facade 是当前包的公开源码边界。后续重构不得仅因为内部拆分而删除、改名或改变这些导出语义。

### CLI 命令和选项（源码确认）

`packages/coding-agent/src/cli/help.ts` 和 `src/cli/args.ts` 是当前 CLI 契约来源。现有公开选项按用途分组如下：

- 通用：`--help/-h`、`--version/-v`
- 模式：`--print/-p`、`--mode`、`--export`
- Model：`--provider`、`--model`、`--api-key`、`--thinking`、`--models`、`--list-models`、`--context-window`
- Session：`--continue/-c`、`--resume/-r`、`--session`、`--session-id`、`--fork`、`--session-dir`、`--no-session`、`--name/-n`
- Tools：`--tools/-t`、`--exclude-tools/-xt`、`--no-builtin-tools/-nbt`、`--no-tools/-nt`
- Resources：`--extension/-e`、`--no-extensions/-ne`、`--skill`、`--no-skills/-ns`、`--prompt-template`、`--no-prompt-templates/-np`、`--theme`、`--no-themes`、`--no-context-files/-nc`
- 其他：`--system-prompt`、`--append-system-prompt`、`--agent-role`、`--verbose`、`--offline`、`--approve/-a`、`--no-approve/-na`

帮助文本还公开了 `@file` 输入、普通消息输入、`myharness install|remove|update|list` 和 `myharness config [-l]`。未知的 `--` 选项会保留在参数映射中，供 extension 等调用方继续处理；不能将其当成可以随意删除的“无效参数”。

当前 session 选择行为：

- `--no-session` 和仅列 model 的路径使用 in-memory session。
- `--fork` 调用 `SessionManager.forkFrom`。
- `--session` 打开指定文件；跨 project 时按当前实现处理为提示或 fork。
- `--resume` 打开交互式 session picker；`--continue` 继续最近 session。
- `--session-id` 按 id 定位或重建对应 session；没有指定目标时创建新 session。
- package/config 命令和 `--help`、`--version` 在进入普通 session/runtime 前短路处理。

## 2. Settings JSON

### 文件位置和合并

实现位于 `packages/coding-agent/src/config/settings/`，其中 `manager.ts` 负责协调，`types.ts`、`defaults.ts`、`migrations.ts` 和 `storage.ts` 分别承载 Settings 契约、默认值/合并、迁移和持久化；项目 Trust 位于 `src/config/trust/`，配置文件路径位于 `src/config/paths/`。Phase 9 已移除旧的 Settings/Trust 兼容入口，正式代码直接使用这些配置模块。

- Global：`~/.myharness/agent/settings.json`
- Project：当前项目下的 `.myharness/settings.json`
- Project settings 覆盖 global settings；嵌套 object 递归 merge，array 和 primitive 由覆盖值替换。
- 读取不存在的文件不应为了“初始化”而产生写入。
- 保存使用 lock、临时文件和 atomic rename；后续实现必须保留这一写入安全边界。
- settings 中的 resources 路径相对于对应 scope 的 agent/config directory 解析，也支持 absolute path、`~` 和 glob/exclusion 语义。

### 当前顶层字段

以下是当前 `Settings` interface 的兼容字段集合；字段可选，具体默认值由现有 manager/UI/runtime 决定：

`lastChangelogVersion`、`defaultProvider`、`defaultModel`、`defaultThinkingLevel`、`transport`、`steeringMode`、`followUpMode`、`theme`、`compaction`、`contextWindow`、`branchSummary`、`retry`、`hideThinkingBlock`、`showCacheMissNotices`、`externalEditor`、`shellPath`、`quietStartup`、`defaultProjectTrust`、`shellCommandPrefix`、`npmCommand`、`collapseChangelog`、`enableInstallTelemetry`、`enableAnalytics`、`trackingId`、`packages`、`extensions`、`skills`、`prompts`、`themes`、`enableSkillCommands`、`terminal`、`popupNotifications`、`images`、`enabledModels`、`doubleEscapeAction`、`thinkingBudgets`、`editorPaddingX`、`outputPad`、`autocompleteMaxVisible`、`showHardwareCursor`、`markdown`、`warnings`、`subAgent`、`autoMemory`、`visionAssistant`、`codeIntelligence`、`visionCapabilityTests`、`disabledProviders`、`gitIntegration`、`usageRanking`、`sessionDir`、`httpProxy`、`httpIdleTimeoutMs`、`websocketConnectTimeoutMs`。

Provider credentials 不属于 settings JSON；它们仍由下面的 `auth.json` 机制负责。

## 3. Auth / Credential JSON

源码：`packages/coding-agent/src/providers/credentials/auth-storage.ts`；Phase 9 已移除旧的 AuthStorage 兼容入口，公开 facade 仍从 Provider credentials 模块转发。

- 默认文件：`~/.myharness/agent/auth.json`。
- 顶层是 provider id 到 credential record 的映射。
- 传统单 key record `{ "type": "api_key", "key": ..., "env": ... }` 仍可读取，不会被当成失效格式。
- 多 API key 元数据使用保留字段 `__piApiKeys`，包含 active id、entry id、label、credential、fingerprint、可选末四位和创建时间。
- 保存的 OAuth 信息使用保留字段 `__piOAuth`；OAuth 和 API key 可以共存，当前 credential 选择语义由现有 AuthStorage/ModelRuntime 保持。
- 读取会去掉内部 metadata 后再向调用方返回 credential；日志、测试输出和文档不得泄露 key、OAuth token 或环境变量值。
- 写入使用 provider lock、临时文件和 atomic rename；文件权限目标为 `0600`，agent directory 使用 `0700`。
- API key 的环境变量解析、命令行覆盖、外部编辑和 malformed file 处理以现有实现和 `auth-storage.test.ts` 为准。

## 4. Session JSONL、resume、fork 和 compact

源码：`packages/coding-agent/src/session/manager/index.ts`、`src/session/storage/jsonl/`、`src/session/projection/`、`src/session/migrations/`；格式说明：`docs/session-format.md`。

### 文件和版本

- 默认路径：项目根目录的 `data/workspaces/<workspace-id>/sessions/<session-id>/conversation/<timestamp>_<uuid>.jsonl`；Workspace 和 Session 使用稳定 ID，Workspace registry 只保存真实 Workspace 根目录对应的记录。
- 第一行是 `type: "session"` header，包含 version、session id、timestamp、cwd 和默认存储下的 `workspaceId`；fork/parent session 还可包含 `parentSession`。
- 当前 `CURRENT_SESSION_VERSION = 3`。
- v1 是线性旧格式，v2 引入 `id/parentId` tree，v3 将旧 `hookMessage` 角色统一为 `custom`。
- 读取旧版本时执行当前 migration；已迁移内容可被重写为当前版本。坏行、空行等容错行为由当前 parser 和现有测试固定，不能凭重构需要改变。

### 当前 entry 类型

`message`、`thinking_level_change`、`model_change`、`compaction`、`branch_summary`、`custom`、`custom_message`、`label`、`session_info`。除 header 外，tree entry 使用 `id`、`parentId`、ISO timestamp 等基础字段。

### 关键行为

- Resume/continue 重新打开相同 JSONL 文件并从 tree leaf 构建当前 context；model 和 thinking level 从当前路径恢复。
- Fork 保留源 session 的 parent 关系和 tree 语义，并创建新的 session 文件；`--fork` 的 CLI 路径不能退化成“复制纯文本”。
- Branch navigation 以 entry tree 为基础；`createBranchedSession` 可以把指定 leaf 分支提取成新的 session。
- Compact 写入 `compaction` entry，保留 summary、`firstKeptEntryId`、`tokensBefore`，并可带 usage、details、`fromHook`、`replacementHistory`。
- Context 构建先沿 leaf 到 root 收集路径，再按 compaction 的保留边界构建 LLM message context；`custom` 不进入 LLM context，`custom_message` 进入。

## 5. System Prompt 加载和注入

源码：`packages/ai/src/api/system-prompt-loader.ts`、`packages/coding-agent/src/system-prompts/loader/index.ts`、`packages/coding-agent/src/system-prompts/composer/index.ts`、`packages/coding-agent/src/context/project-context-loader.ts`。旧的统一 Resource Loader 入口已在 Phase 9 移除；需要聚合兼容行为的 `application/resource-loader.ts` 仍只协调专用 loader，不承担各类资源的底层实现。

### 实际加载根目录

优先级和路径是源码确认的：

1. `MYHARNESS_SYSTEM_PROMPT_DIR` 非空时直接使用。
2. Bun binary 使用 `dirname(process.execPath)/system-prompts`。
3. monorepo 源码环境从仓库根的 `system-prompts` 加载。
4. 安装包使用编译模块旁边的 `system-prompts`。

加载器要求 prompt 文件使用小写路径和 `.md` 后缀；以 UTF-8 fatal 解码，规范化 CRLF，去掉一个末尾换行，并替换 `{{name}}` 变量。路径非法、文件不存在、空文件、非法文本或变量缺失时会 warning 并返回空字符串，不会静默拼入 fallback 文本。模块级 prompt 常量要重启进程才会刷新。

### 注入顺序

`buildSystemPrompt` 当前组合顺序为：global core policy、available tools、tool routing、active tool guidelines、custom/append system prompt、project context、skills、working directory、current model、output language policy，最后重新应用 agent role boundary。后续重构必须保持实际注入内容和条件语义。

## 6. Extension API 和 Provider loading

### Extension API

源码公共 facade 导出 Extension 类型、`ExtensionAPI`、`ExtensionRuntime`、`ExtensionRunner`、tool definition/result helper、event/command/shortcut/flag/renderer 类型和 discovery/runtime 函数。

当前资源加载按职责分开：`extensions/loader/` 负责 extension module/factory 加载与冲突诊断，`skills/loader/` 和 `prompts/loader/` 负责对应文件资源及去重，`themes/loader/` 只解析无 UI 的 Theme JSON resource，`context/project-context-loader.ts` 负责 AGENTS/CLAUDE context，`system-prompts/loader/` 负责 system prompt 文件发现及底层 prompt 内容边界。旧 `DefaultResourceLoader` 仍作为兼容 facade 协调这些 loader，保留 CLI、settings、packages、显式路径和 project trust 的原有优先级；具体 TUI `Theme` 仍只在 `modes/interactive/theme/` 中由前端创建。

### Provider loading

`packages/coding-agent/src/providers/` 是 MyHarness 产品层 Provider 边界：`runtime/` 负责组合、激活和生命周期协调，`credentials/` 负责 auth.json、运行时密钥和 legacy vision-auth 迁移，`models/` 负责 models.json、model store、custom provider 与 ModelRegistry，`recovery/` 负责 Provider 调用故障恢复。`ModelRuntime` 兼容 facade 已在 Phase 9 移除，正式入口为 `providers/runtime/`；`@myharness/ai` 继续提供底层 Provider/Model API。Provider 的具体网络行为、OAuth 流程和真实 model 请求不在本基线中伪造成功；本阶段只保护当前加载接口和已有本地测试。

## 7. Git checkpoint 和 commit

源码：`packages/coding-agent/src/git/checkpoints/checkpoint.ts`、`packages/coding-agent/src/git/repository/integration.ts`。

### Checkpoint

- `CHECKPOINT_VERSION = 2`，仍兼容 legacy v1。
- 默认 metadata 存放在 `~/.myharness/agent/checkpoints/<sessionId>/<checkpointId>/checkpoint.json`；文件写入使用 atomic write 和 `0600`。
- Git 内部使用隐藏 refs：`refs/myharness/checkpoints/<session>/<id>/worktree` 和 `.../index`。
- checkpoint 记录 session/run/actor、cwd/repository root、HEAD/ref/status hash、排除路径、local refs、worktree/index tree 和状态；恢复失败时会持久化 `invalid` 状态及诊断原因，避免会话无限重复进入 recovery。
- restore 覆盖仓库 worktree、index、HEAD 和普通 local refs；只移除 checkpoint 之后新增的精确未跟踪路径，并保留其中的嵌套 Git 仓库。它明确不恢复 ignored files、仓库外文件、global config、credential helper 或 remote 效果；linked worktree、submodule dirty state、rebase state 等也不在保证范围。
- created checkpoint TTL 为 7 天，resolved checkpoint TTL 为 1 小时；普通 Git 操作默认 timeout 为 30 秒，checkpoint Git 操作另用 180 秒。

### Commit

`git-integration.ts` 使用 repository-local Git，baseline 和 commit 范围由当前实现决定；save/commit 只处理当前 task 通过 edit/write 修改的路径，提交前后核对 commit hash 并处理失败重试/恢复。`/commit` 不负责远端操作。显式 `/push` 由 `application/use-cases/git-push.ts` 编排：从当前 branch 的真实 upstream fetch，检查 ahead/behind 与 dirty 状态，只执行精确 branch ref 的非强制 Push，重新验证 remote SHA，然后按 `.github/workflows` 中匹配当前 branch 的 branch-push workflow 查询最终 commit 的 CI；CI 修复只允许通过新的 follow-up commit 再走同一流程。

## 8. Windows 启动和 Bun binary

### Windows source startup

当前链路是：

`dev.cmd` → `powershell.exe -NoProfile -ExecutionPolicy Bypass -File dev.ps1` → `myharness-test.ps1` → `node_modules/.bin/tsx.cmd packages/coding-agent/src/cli.ts`。

`dev.ps1` 从根 `package.json` 读取 `engines.node`，检查 Node/npm，缺依赖时使用 `npm install --ignore-scripts`，bash/ffmpeg 缺失只警告，然后把参数交给 source CLI。 `myharness-test.ps1 --no-env` 会清理现有 provider/cloud credential 环境变量，其余参数继续转发。

### Bun binary

`packages/coding-agent/package.json` 的 `build:binary` 使用 Bun compile `dist/bun/cli.js`，同时纳入 image-resize 和 JPEG XL worker，输出 `dist/myharness`，并复制 `system-prompts`、theme、assets、export-html、docs、examples 等运行时资源。

`src/bun/cli.ts` 的启动顺序是注册 Bun OAuth flows、恢复 sandbox 环境、加载 Bedrock 注册模块，再加载普通 CLI。编译 binary 通过 `src/config.ts` 的 `isBunBinary` 将 package、theme、export-html 和 interactive assets 解析为 executable 旁边的目录。

## 9. Phase 0 验证矩阵

### 已有测试，作为行为基线

关键流程优先复用已有 Vitest 测试：

| 领域 | 现有验证 |
| --- | --- |
| Session resume / JSONL 读写 / invalid input | `test/session-manager/file-operations.test.ts`、`session-file-invalid.test.ts`、`session-cwd.test.ts` |
| Session fork / tree / branch | `test/session-manager/tree-traversal.test.ts`、`agent-session-branching.test.ts`、`agent-session-tree-navigation.test.ts` |
| Context compact | `test/agent-session-compact-flow.test.ts`、`compaction.test.ts`、`compaction-serialization.test.ts`、`agent-session-compaction.test.ts` |
| Git checkpoint | `test/git-checkpoint.test.ts`、`agent-session-git-checkpoint-events.test.ts` |
| Git commit / Push / Actions evidence | `test/git-integration.test.ts`、`git-commit-message.test.ts`、`git-push.test.ts`、`account-connections.test.ts` |
| Provider loading | `test/configured-providers.test.ts`、`test/agent-session-dynamic-provider.test.ts`、`test/custom-provider-manager.test.ts`、`test/phase7-provider-architecture.test.ts` |
| Extension loading | `test/extensions-discovery.test.ts`、`test/extensions-runner.test.ts` |
| Prompt loading/injection | `test/system-prompt-files.test.ts`、`test/system-prompt.test.ts` |
| CLI/Windows-related path contracts | `test/args.test.ts`、`test/cli-help.test.ts`、`test/config.test.ts`、`test/paths.test.ts` |

在本阶段新增的 `test/phase0-baseline.test.ts` 只做源码/资源契约守护：package facade、Windows 启动链、Bun 编译入口和资源路径、system-prompt roots。它不启动模型、不写用户配置、不替代真实 runtime E2E。

### 本阶段已执行的验证

- Phase 0 修改前的目标回归集：18 个 test files，384 passed，2 skipped。
- 加入本阶段守护测试后的目标回归集：19 个 test files，388 passed，2 skipped，exit 0。
- 完整 workspace npm.cmd test：exit 0。Agent package 为 18 files / 199 passed / 1 skipped；AI package 为 30 files passed、1 file skipped / 172 passed / 1 skipped；coding-agent 为 264 files passed、4 files skipped / 2827 passed / 60 skipped；TUI 的 node --test 也 exit 0。
- 只读等效检查 node scripts/run-checks-parallel.mjs：pinned-deps、ts-imports、shrinkwrap、install-lock、tsgo、browser-smoke 全部 exit 0。
- git diff --check：exit 0。当前变更只有本基线文档、文档索引链接和守护测试。
- Windows 实际启动验证 .\dev.cmd --help：exit 0。dev.cmd、dev.ps1、myharness-test.ps1、tsx source CLI 链路真实运行；Node/npm/bash 检查通过，ffmpeg-static 缺失只产生现有 warning，未阻止 help 退出。

为避免源码被改写，本阶段不运行根目录 `npm run check`。需要执行等效只读检查时使用 `node scripts/run-checks-parallel.mjs`；该脚本不包含 `biome check --write`。

## 10. 当前未确认边界

- 没有 API key 的真实 Provider/model 网络请求成功证据；需要 API key 的 branching 测试会按当前测试条件 skip。
- 没有把 Bun binary 真正编译并启动；本阶段只确认 build script、entrypoint 和资源复制契约。
- 没有声称 `dev.cmd` 已启动一个真实交互式 TUI；启动链通过源码守护测试，真实启动需单独记录运行时输出和退出码。
- 没有验证外部 OAuth、浏览器授权、远端 Git 或 remote side effects。
- 没有改变生产代码、目录迁移、AgentSession/InteractiveMode 拆分、Tool/Git/Session/Provider/Prompt 业务语义或持久化格式。

Phase 0 的完成边界到此为止：确认上述基线测试和只读检查可靠后停止，不进入 Phase 1～10。
