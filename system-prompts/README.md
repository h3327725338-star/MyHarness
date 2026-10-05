# 自动注入系统指令

直接编辑本目录的 UTF-8 `.md` 文件，然后重启 MyHarness。无需编译 Prompt、无需生成文件，也没有 watcher。内置提示词正文统一使用英文，采用 `# ` 标题和 `- ` 正文；标题紧接正文，板块之间空一行。本说明不注入模型。

维护规则见 [maintenance.md](maintenance.md)，后续开发边界见 [roadmap.md](roadmap.md)。

## 文件与作用域

| 文件（相对本目录） | 职责与生效条件 |
| --- | --- |
| `global/core.md` | 编程会话的通用行为、证据、工作方式和沟通规则 |
| `global/output-language.md` | 编程会话的用户回复语言策略 |
| `roles/main.md` | Main 授权边界；保留现有 `reviewer` 同样使用此文本的行为 |
| `roles/delegated.md` | 只读委派会话的执行边界 |
| `roles/explore.md` | Explore 子进程通过 `--append-system-prompt` 追加的专用职责 |
| `session/commit-authorization.md` | 当前不存在；显式 `/commit` 的授权和 Git 事务边界由 Coding Agent 源码处理，不会从本目录加载 |
| `session/auto-memory.md` | 仅 Auto Memory 完整启用时追加的记忆优先级约束 |
| `session/project-context.md` | 有项目上下文时使用，变量 `projectContext` |
| `session/artifacts.md` | 持久化结构化 Session 的临时产出存放规则，变量 `artifactsDir`；由 `_getTurnSystemPrompt` 追加实际对话路径，不适用于正式源码或用户指定路径 |
| `session/working-directory.md` | 当前工作目录，变量 `cwd` |
| `session/model-identity.md` | 当前模型已知时使用，变量 `name`、`provider` |
| `skills/coding-agent.md` | 编程会话的技能读取规则；仅启用 read 且存在可见技能时有正文 |
| `skills/harness.md` | 通用 AgentHarness 的技能说明；原文不同，独立维护 |
| `harness/default.md` | 通用 AgentHarness 未提供自定义 systemPrompt 时的默认身份 |
| `tools/{read,bash,pwsh,edit,write,find,grep,ls,github,symbols,agent,workflow,ultracode,web-search,web-fetch}/snippet.md` | 对应工具的简短系统说明；仅启用该工具时组合 |
| `tools/{read,edit,write,symbols,agent,workflow,ultracode,web-search,web-fetch}/guidelines.md` | 对应工具的操作规则；每个非空行是一条，按文件行序组合 |
| `tools/no-snippets.md` | 有工具但无简短说明时的提示 |
| `tools/routing/introduction.md` | 工具选择通用引言 |
| `tools/routing/symbols.md`、`evidence-heading.md` | symbols 启用时的证据工具路由及标题 |
| `tools/routing/{agent,workflow,ultracode}.md` | 各编排工具启用时的选择规则 |
| `tools/routing/organization-heading.md`、`organization-boundary.md` | 至少一个编排工具启用时的标题与组合约束 |
| `compaction/coding-agent/system.md` | 编程会话压缩、分支摘要、长回合前缀摘要的系统职责 |
| `compaction/harness/system.md` | 通用 AgentHarness 压缩及分支摘要的系统职责；与编程版不同，不能直接合并 |
| `memory/extractor.md`、`consolidator.md` | 后台独立记忆提取、合并请求的职责；优先更新、区分已确认事实与建议、保留适用条件；归档被替代内容 |
| `memory/recalled-context.md` | 召回记忆消息的说明；此项属于消息正文，和记忆系统约束配套管理 |
| `tasks/conversation-title.md` | 独立会话标题生成请求 |
| `tasks/vision-assistant.md` | 独立视觉转录请求 |
| `tasks/vision-probe.md` | 图像输入能力探测请求 |
| `tasks/shell-adjudicator.md` | 生成的只读 shell 审查扩展内，受保护候选命令的 AI 判定请求 |
| `providers/anthropic/oauth-identity.md` | **仅 Anthropic adapter 的 OAuth 分支**；不注入普通 API Key、OpenAI、Google、Bedrock 或 Mistral 请求 |

这里的 global 表示编程会话共享规则，不表示所有辅助模型请求都套用编程 Agent 的规则。

## 与仓库开发规则的边界

根 `system-prompts/` 是 MyHarness 产品本身运行时使用的静态 System Prompt 资源，
面向所有使用 MyHarness 的项目。它不承载 MyHarness 仓库自己的 CI runner、维护
流程、开发细节或 Agent 项目规则；这些内容应放在根 `AGENTS.md`、
`DOCUMENTATION_INDEX.md` 和对应专题文档中。

用户项目的 `AGENTS.md`/`CLAUDE.md`、`SYSTEM.md`/`APPEND_SYSTEM.md`、skills 和
Extension Prompt 由 Coding Agent 的 ResourceLoader/context loader 独立处理，
不应在本目录再建立一套重复的 project-rules loader。`AGENTS.md` 是纯文本项目
上下文，除非关闭 context loading，否则不因 Project Trust 被跳过；它与本目录的
产品 System Prompt 不是同一种资源。

## 加载、顺序与异常

唯一文本入口：`packages/ai/src/api/system-prompt-loader.ts` 的 `loadSystemPrompt` / `loadSystemPromptLines`。编程会话的组合入口是 `packages/coding-agent/src/system-prompts/composer/index.ts`，本地 loader 边界是 `packages/coding-agent/src/system-prompts/loader/index.ts`；各独立任务只加载自己的文件，不遍历目录或按字母序自动注入。

编程会话顺序保持为：核心 → 当前工具说明 → 工具路由 → 当前工具规则 → 自定义 Prompt → append Prompt → 项目上下文 → 技能 → 工作目录 → 当前模型 → 回复语言 → 角色边界。

扩展按原注册顺序变换 Prompt；随后按原条件追加 Auto Memory 规则，在持久化结构化 Session 中追加对话产出规则和实际目录，再去除旧角色块并重新追加当前角色边界。这保留了原来的角色块去重逻辑。Anthropic OAuth 身份由 adapter 单独放在以上文本前面。显式 `/commit` 的授权、失败恢复和 Git 事务由 `packages/coding-agent/src/modes/interactive/interactive-mode.ts`、`agent/runtime/agent-session.ts` 等源码处理，不对应一个本目录中的静态 Prompt 文件。

- `{{variable}}` 是纯文本替换，不执行代码，也不递归解释变量值。保留模板内原有变量名。
- 正文不 trim；文件末尾一个换行作为文本文件终止符移除，CRLF 统一为 LF。
- 文件不存在、空白、不可读、非法 UTF-8、控制字符或缺少模板变量：向 stderr 输出包含文件路径和原因的 `[system-prompts] warning: skipping ...`，返回空文本并继续。没有旧硬编码后备文本。
- 源码和仓库内 dist 运行时，固定读取 **MyHarness 安装仓库根目录**，不跟随用户项目 cwd。打包时将可编辑副本放入 ai 的 `dist/system-prompts`；Bun 二进制使用可执行文件旁的 `system-prompts`。
- 可用 `MYHARNESS_SYSTEM_PROMPT_DIR` 指定完整替代目录（建议绝对路径）。替代目录内缺失文件同样 skip，不偷偷回退。
- 模块常量在进程加载时读取，部分工具及动态模板在构建时读取；重启是使所有编辑一致生效的方式。
- 文件系统不可用的运行时会 warning + skip；浏览器打包兼容不等于浏览器能够读取本地文件。

`SYSTEM.md` 和 `APPEND_SYSTEM.md` 不属于本目录的静态资源清单。当前 Coding
Agent loader 在项目受信任时优先使用 `<cwd>/.myharness/SYSTEM.md` 或对应的
`APPEND_SYSTEM.md`，否则回退到全局 `<agentDir>/SYSTEM.md` 或对应的 append
文件；每个文件名只选择一个来源，不把全局和项目文件简单合并。前者作为 custom
system prompt，后者作为 composer 的追加内容。

## 注入链路与保留内容

主链路：CLI/SDK → ResourceLoader 加载用户自定义与项目上下文 → AgentSession `_rebuildSystemPrompt` 收集有效工具 → `buildSystemPrompt` → `before_agent_start` 扩展变换 → `_getTurnSystemPrompt` 重施角色及 commit 边界 → Agent state → agent-loop 的 `Context.systemPrompt` → ModelRuntime / provider stream → adapter 组包 → SDK HTTP 请求。`onPayload` 扩展仍可按原接口变换最终请求。

请求映射：OpenAI Completions/Responses 使用原来的 system/developer 角色判断；Anthropic 使用 system text blocks；Google Generative AI/Vertex 使用 systemInstruction；Bedrock 使用 system text 与缓存块；Mistral 在 messages 首部插入 system。Kimi 延迟工具的 system 消息只有动态工具 schema，没有固定自然语言正文。

独立链路：压缩及分支摘要 → 各自的摘要执行器；记忆/标题/视觉探测/视觉转录 → ModelRuntime.completeSimple；shell 审查扩展 → 自己的 chat/completions 请求；Explore → 临时 append 文件 → 子进程 CLI → 同一主组合入口。通用 AgentHarness 的默认/自定义 systemPrompt → 自身 turn context → agent-loop；不会自动套用编程会话全局规则。

代码仍生成工具集合、schema、技能列表与 XML 转义、项目文件路径及正文、cwd、模型/provider 名称、对话和运行状态。这些是实际运行时数据；上述系统字段周围的固定自然语言模板已外置。

用户拥有的 SYSTEM.md、APPEND_SYSTEM.md、AGENTS.md、CLAUDE.md、Skill 内容和扩展提供的自定义 Prompt 保留原加载方式，未复制到此目录。工具 API schema 的 description、压缩任务的 user 消息格式模板、恢复/续接 user 消息和 slash-command 模板并非系统指令，保留原职责和消息角色。本次没有把这些内容提升为 system，也没有迁移示例扩展或第三方 LSP 工具链的指令。

## 迁移验证记录与当前核对

下面的迁移数字和测试结果是历史记录，不代表每次 checkout 都重新执行过；当前结论必须以源码、测试和实际命令输出为准。

- 原迁移时目录共有 55 个 Prompt 正文 `.md` 文件；另有 `README.md`、`maintenance.md`、`roadmap.md` 维护文档，这三者不在 loader 的 Prompt 资源清单中。`session/commit-authorization.md` 不在其中。
- 相关测试入口包括 `packages/ai/test/system-prompt-loader.test.ts`、`system-prompt-provider-scope.test.ts` 和 `packages/coding-agent/test/system-prompt-files.test.ts`。
- 这些测试文件的存在只能证明测试入口和覆盖意图；本次文档核对没有把它们的历史记录写成新的测试通过结论。
- 历史终端 smoke 曾验证本地 Provider、429 恢复、read 工具与会话续接；对应终端测试脚本已随旧入口移除，这不是当前 Web 启动的验证结果。
- `npm run build:offline`、全仓只读 Biome 检查、`node scripts/run-checks-parallel.mjs`（typecheck、浏览器打包、模型数据、依赖及锁文件等）通过。Biome 仅报告原有文件的两条 info；新增 HTTP 测试曾有类型错误，已修正并复验通过。
- 仓库外的安装目录副本与实际编译的 Bun Loader 均验证了相邻 Prompt 资源加载。完整 Bun CLI 跨平台发行构建、云端模型响应及浏览器运行时文件读取未验证。
