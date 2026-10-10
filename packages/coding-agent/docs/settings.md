# Settings（设置）

MyHarness 使用 JSON settings files，project settings 会覆盖 global settings。

| 位置 | Scope |
|----------|-------|
| `~/.myharness/agent/settings.json` | Global（所有 projects） |
| `.myharness/settings.json` | Project（当前目录） |

可以直接编辑文件，也可以使用 `/settings` 修改常用选项。

## Web 外观与配色主题

设置 → 外观的“显示模式”保留跟随系统／深色／浅色；“阅读宽度”下方新增“配色主题”：经典炭黑（`classic`，原 Coding 配色）、静谧森林（`forest`，克制灰绿）和暖夜琥珀（`amber`，暖棕深灰）。选择立即生效，并通过现有浏览器偏好 `myharness.web.prefs` 的 `colorThemes.coding` / `colorThemes.general` 分别保存，刷新前的启动脚本也读取它，避免先显示另一套配色。旧版共享 `colorTheme` 首次读取时作为两边初始值保留，之后各自独立修改；未设置或无效值使用经典炭黑。设置只修改当前 Coding／General 模式的配色，切换时恢复目标模式的选择；当前三套仅改变深色显示，浅色共用基础配色。无需重启，不写入项目或全局 Agent settings。

## Web 专属快捷键与代码智能状态

Web 设置新增 Keyboard shortcuts 页面，默认 Ctrl+Alt+字符组合，可录入自定义键位；冲突时标红、提示且不保存。配置保存在当前浏览器，不改终端 `keybindings.json`。关于页和实际监听共用键位注册表。网络页对 Provider 传输方式提供说明；**自动重试次数**是自由输入的数字加可选单位（次／无限）。原来的单个“HTTP 空闲超时”已拆成“超时与重试”卡片里互相独立的三个时限（建连、首包、静默，单位秒，存储仍是毫秒）加“同一模型最多尝试次数”，详见 [Retry](#retry) 下的“网络超时与网络失败重试”。

代码智能页把保存的配置与运行时实际状态分开显示，每秒比对；需要重启时提供一键重启本地 Web 服务，运行中的任务必须先停止。详见 [Web UI](web-ui.md)。

## Popup notifications（任务结束提醒）

Interactive mode 和 Web UI 都可以在任务完成、失败或中断后显示桌面提醒，默认开启（Web UI 优先用浏览器通知，浏览器不允许或没有页面打开时用同一个系统弹窗，见 [web-ui.md](web-ui.md)）。可以在全局或项目 settings 中配置：

```json
{
  "popupNotifications": {
    "enabled": true,
    "style": "toast",
    "onCompleted": true,
    "onError": true,
    "onInterrupted": true
  }
}
```

也可以在会话内通过 `/settings` 切换总开关。`style` 支持默认的 `toast` 和需要手动关闭的 `window`；三个 `on...` 字段分别控制完成、异常和中断提醒。

## GitHub Connect

打开 `/settings` → **GitHub Connect** → **连接 GitHub**。在 GitHub 中输入界面显示的 code 并确认授权。这里没有 third-party account list 或多页 wizard。如果缺少 Client ID，单个 setup screen 会提供所需的表单字段和注册 OAuth App 的链接。已有 Client IDs 仍可使用；`MYHARNESS_GITHUB_CLIENT_ID` 会覆盖已保存的值。不需要 Client Secret。

连接会请求以下 broad scopes：`repo`、`workflow`、`user`、`admin:org`、`admin:repo_hook`、`admin:org_hook`、`admin:public_key`、`admin:gpg_key`、`admin:ssh_signing_key`、`gist`、`notifications`、`delete_repo`、`write:packages`、`delete:packages`、`codespace` 和 `project`。这些权限包含 private repositories、account email addresses 以及管理/删除权限。实际访问仍受用户自身权限、GitHub 已授予的 permissions 和组织 SSO policy 限制。GitHub email APIs 只会列出地址，不会读取 email inbox。通过以前的 identity-only flow 创建的连接需要**重新授权**才能获得扩展后的 permissions。

默认的 main-agent `github` tool 会使用已保存的 credentials 发送 authenticated REST 和 GraphQL JSON requests，不需要 GitHub CLI。例如，`/user/repos?visibility=private&per_page=100` 用于列出 private repositories，`/user/emails` 用于列出 account email addresses。分页时继续请求返回的 `next` path。Requests 仅允许访问 `api.github.com`，会拒绝 redirects，tokens 也不会出现在 tool arguments 或 shell environments 中。Tool 支持 GET、POST、PUT、PATCH 和 DELETE；写操作仍需要用户针对具体操作给出 instruction。它不会改变系统 Git/SSH 或 `gh` login state。显式的 tool allowlists 和 delegated-session restrictions 仍然有效。

即将过期的 credentials 会在 API access 或**验证连接**前自动 refresh。已保存的 accounts 会标记为**已保存**，不会被表述为远程有效。Refresh 失败可通过**重新授权**解决。Credentials 仍保存在现有的 `~/.myharness/agent/account-connections.json` 文件（或配置的 agent directory）中，依靠 filesystem permissions、locking 和 atomic writes 保护，不使用 keychain encryption。**断开连接…** 会删除本地 credentials；**打开 GitHub 授权管理**可以单独撤销远程 OAuth grant。

<a id="providers-api-keys-and-default-model"></a>
## Providers、API Keys 和 Default Model

`/settings` 将已配置、已注册和 custom API services 统一放在 **Providers** entry 中：

- **Providers** 会把 services 分为**已启用**和**已保存但未启用**。两组可以包含 `models.json`、extension/native registration 和 custom Providers。
- 打开某个 Provider 可以管理它的 enabled state、models 和 Provider-level API keys。禁用 Provider 会保留其 configuration 和 credentials，但会将它的 models 从普通选择列表中移除。
- 当前选中的 API Key 会被该 Provider 下的所有 models 使用，包括 main model、Auto Memory、Sub Agent、Workflow 和 Vision Assistant。
- **添加 Provider** 可以输入已知 Provider ID 配置密钥，也可以为兼容的 third-party service **创建自定义 Provider**。当前 MyHarness 没有由 `packages/ai/src/providers/all.ts` 提供的默认 Provider 列表，也没有内置 Provider。
- **Default Model** 用于选择 main model，然后只列出该 model 实际支持的 thinking levels。选择结果会成为当前 model，并保存为后续 sessions 使用的 global default。
- **Vision Assistant** 只会选择来自 enabled Provider 且已确认支持 image input 的 model。

每个支持 API Key 的 Provider credential screen 都会列出已保存的 keys 和**添加新的 API Key**；OAuth-only Provider（由 Extension 注册）显示其官方登录入口，不要求输入 API Key。

Provider credentials 保存在 `~/.myharness/agent/auth.json` 中。文件以 plain text 保存 key values，依赖本地 filesystem permissions 保护，并不是 encrypted vault。输入 key 时会隐藏内容，Settings UI 只显示用户定义的 label，以及可用时的末四位字符。

每个 Provider 有一个由其 models 共享的 current credential。MyHarness 不会在已保存的 keys 之间自动 rotate 或 fail over。命令行提供的 runtime key 会覆盖该进程的 Provider credential。

已保存的 OAuth credentials 和 API keys 可以共存。OAuth 为 current 时添加 API key 不会丢弃或替换 OAuth；你可以手动在两者之间切换。删除 key 需要确认，确认后只会从本地删除，不会修改 environment variables 或远程 Provider accounts。已有的单 key `auth.json` entries 仍兼容，并显示为**默认密钥**。启动时，MyHarness 会把 legacy `vision-auth.json` collection 中保存的 API keys 导入 `auth.json`，同时保留 legacy file 作为 rollback copy。

MyHarness 可以确认 credential 已保存、Provider 的 model catalog 已加载，但许多 Providers 没有无副作用的 key-validation endpoint。对于这些 Providers，key 是否真正有效只能通过第一次 model request 确认。因此，MyHarness 不会把新输入的 key 标记为 remotely verified。

Vision Assistant 接受声明支持 image input 的 models，以及通过 MyHarness manual image-capability test 的 custom models。如果 Provider 有已保存的 API key，unknown custom models 会直接出现在 vision-model picker 中；选择后会先运行 image-capability test，测试通过才启用，不会再次询问 key。明确声明为 text-only 的 models 会被排除。如果没有 enabled Provider 提供符合条件的 model，Settings screen 会链接回 **Providers**。

### Custom Providers（自定义 Provider）

Custom Providers 会出现在与其他 configured/extension services 相同的 **Providers** lists 中。使用 **Providers** → **添加 Provider** → **创建自定义 Provider** 创建；保存后，从普通的 Provider entry 管理它。

创建 wizard 会要求填写：

1. display name 和唯一的 lowercase Provider ID；
2. 一种受支持的 API type：OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 或 Google Generative AI；
3. API base URL；
4. Provider 使用 API key 还是 keyless local service；
5. 从 service 的 `/models` endpoint 选择或手动输入 model；
6. 明确的 text/image 和 reasoning capabilities、context-window size 以及 maximum output size。

自动 model lookup 只是便利功能。有些兼容 services 不提供 `/models`、使用不同的 endpoint，或会阻止 catalog requests。lookup 失败时会打开手动输入 model ID 的流程，不会直接把 Provider 判定为不可用。

保存时会将 Provider 和 model metadata 写入 `~/.myharness/agent/models.json`，reload 正在运行的 model catalog，并将 API key 保存到 Provider credential collection。它不会把 API-key values 写入 `models.json`。如果写入、reload 或 credential storage 失败，MyHarness 会恢复之前的 configuration。GUI 会将 `models.json` 规范化重写为 JSON，因此 active file 不会保留 comments 和 custom formatting；修改前的 source 会保存为 `~/.myharness/agent/models.json.bak`。

已有的 custom/configured Providers 可以进行 connection test、编辑、添加 models 或删除。Connection test 会发送一个很小的 model request，可能产生少量 Provider 费用。删除只由当前 `models.json` configuration 提供的 Provider 时，会删除其 entry、已保存的 credentials、legacy vision-store copy 和 cached remote model catalog；重新创建相同 Provider ID 时不会带回这些本地 credentials。如果是 extension/native Provider 仍提供同一 ID，删除 models.json overlay 后它仍然可用，environment variables 和 remote accounts 也不会改变。custom headers、详细 compatibility overrides 等 advanced fields 仍可直接编辑 `models.json`。

## Project Trust

交互模式启动时，如果项目文件夹包含 project-local settings、resources 或 project `.agents/skills`，且该文件夹或其 parent folder 在 `~/.myharness/agent/trust.json` 中没有已保存的决定，MyHarness 会先询问是否信任项目。信任项目后，MyHarness 才会加载 `.myharness/settings.json` 和 `.myharness` resources、安装缺少的 project packages，并执行 project extensions。

`AGENTS.md` 和 `CLAUDE.md` 是单独的项目上下文文件，不属于上述需要信任的
protected resource；除非使用 `--no-context-files`，否则项目未受信任时也会加载。
项目 `.myharness/SYSTEM.md`/`APPEND_SYSTEM.md` 只有在受信任时才优先于全局同名
文件，未受信任时回退全局文件；它们不是根 `system-prompts/` 静态资源。

启动信任询问由浏览器回答；SDK 或内部 worker 无 UI 时不会显示询问。没有保存的决定时遵循 `defaultProjectTrust`；`ask` 且没有 UI 时不加载需信任的资源。Web 启动仍可用 `--approve` 或 `--no-approve` 覆盖本次 Trust。

如果没有适用的 extension 或 saved decision，`defaultProjectTrust` 控制 fallback behavior。可以在 `~/.myharness/agent/settings.json` 中将它设置为 `"ask"`、`"always"` 或 `"never"`，也可以通过 `/settings` 修改。

`MyHarness config` 和 package commands 使用相同的 Project Trust flow，但 `MyHarness update` 不会询问。使用 `--approve` 可在单次 command 中信任 project-local settings，使用 `--no-approve` 可忽略它们。

交互模式启动时的内置 UI 用于为当前项目保存 trust decision。已保存的决定写入 `~/.myharness/agent/trust.json`。`/settings` 只会修改没有 saved decision 的 projects 使用的 global `defaultProjectTrust` fallback；不会添加或删除当前项目在 `trust.json` 中的 entries。

## All Settings（全部设置）

<a id="model--thinking"></a>
### Model & Thinking（Model 与 Thinking）

| Setting | Type | Default | 说明 |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Default Provider，例如 `"anthropic"` |
| `defaultModel` | string | - | Default model ID |
| `disabledProviders` | string[] | `[]` | Global 禁用的 Provider IDs。Configuration 和 credentials 会保留，但对应 models 不会出现在普通选择中。 |
| `defaultThinkingLevel` | `"off"\|"minimal"\|"low"\|"medium"\|"high"\|"xhigh"\|"max"` | `"medium"` | 七种 thinking levels 之一 |
| `hideThinkingBlock` | boolean | `true` | 启动时折叠 transcript details。折叠后 thinking 只显示 status line，tools 使用 compact summaries；Ctrl+O 可临时切换 Transcript。 |
| `showCacheMissNotices` | boolean | `false` | 在发生明显 prompt-cache miss 时显示 Transcript notice |
| `thinkingBudgets` | object | - | 为每个 thinking level 自定义 token budgets |
| `autoMemory` | object | `{ "enabled": false }` | Global long-term memory configuration。通过 `/settings` 设置。 |
| `conversationNaming` | object | `{ "enabled": false }` | Global 对话自动命名；设置 → 智能体 → 助手选择模型、思考级别和开关。 |
| `subAgent` | object | `{ "enabled": false, "mode": "read-only" }` | Global built-in exploration-agent 和 workflow configuration，含只读/读写模式。通过 `/settings` 设置。 |
| `webSearch` | object | `{ "enabled": false }` | Global built-in web search configuration（搜索引擎和四个数量）；只在启用时向 main Agent 注册 `web_search` 和 `web_fetch`。详见 [Web Search](web-search.md)。 |
| `visionAssistant` | object | `{ "enabled": false }` | Global dedicated image-analysis model configuration。通过 `/settings` 设置。 |
| `fallbackModel` | object | `{ "enabled": false }` | Global 备用模型：主模型重试用完仍失败时自动接管当前任务。通过 `/settings → Fallback Model` 设置，见 [Retry](#retry)。 |
| `visionCapabilityTests` | object | - | custom models 的 image-capability probe results cache，适用于未声明 input support 的 models。可选；尚未执行 probe 时不存在。 |
| `gitIntegration` | object | `{ "enabled": false }` | 仅当前 project 使用的 local Git version history integration。通过 `/settings` 设置。 |

Conversation Naming、Auto Memory、Sub Agent、Vision Assistant 和 Compact Model 选模型的规则相同（`src/agent/runtime/assistant-model.ts`）：

- 没有设置 `provider` / `model`（Web UI 里的“使用主模型”）：运行时使用当前 main model，并且连同它当前的 Thinking Effort 一起继承；main model 变了就跟着变。如果另外写了 `thinkingLevel`，只覆盖 Effort。
- 设置了自己的 `provider` + `model`：使用这个 model 和它自己的 `thinkingLevel`；没写 `thinkingLevel`（Web UI 里的“默认”）时不发送 Effort，相当于 `off`（例如 Gemini 会明确关闭 thinking）。
- 只写了 `provider` 或 `model` 其中一个，视为没有配置。

#### conversationNaming（对话自动命名）

默认关闭，启用后未单独选择模型时跟随当前主模型及思考级别；可在设置 → 智能体 → 助手的“对话自动命名”行选择独立模型、思考级别或关闭。第一条完整回复后后台命名，首次命名不受十分钟冷却限制；已有自动标题后，只处理新增完整回复，距上次成功检查至少 10 分钟且当前 Chat 没有任务、收尾或 Git 操作时检查。命名请求期间出现新回复时，先采用已生成的有效标题，随后在前台任务空闲时立即补查最新内容，不等待十分钟。不要求累积五轮，也不要求再空闲十分钟。主题未明显变化时要求模型保留原名；成功检查但未改名也更新检查时间。中止、错误和工具调用中间回复不作为新完整回复。

待检查内容沿用 Session JSONL 消息，成功检查记录为 `conversation-naming` custom entry（末条已检查回复 ID、检查时间、自动标题 entry ID），不进入主模型上下文。关闭进程不执行，也不为命名延迟退出；下次加载该 Chat 时根据保存的记录补查，不扫描所有历史 Chat。已有手动/显式 AI 标题及后来由用户或扩展设置的标题均不自动覆盖。失败、模型不可用或空输出保留原名和待检查内容；首次尝试失败后，每隔五秒最多再重试三次（前台忙碌时等待空闲），仍失败则停止并显示错误。后台命名关闭 Provider 内层重试，避免叠加次数。重试次数、时间及最终错误保存为 `conversation-naming-retry` custom entry，重新打开 Chat 不会无限重试同一条回复；新增完整回复可开始新的尝试，用户也可点击侧栏“命名失败”重新尝试。侧栏对应 Chat 显示轻量的“命名中”“命名重试 n/3”或“命名失败”，悬停和键盘聚焦可查看失败原因，成功后消失；不阻塞聊天、不弹任务失败通知。对话文本会发送给选择的命名模型并产生额外 API 用量；没有工具权限。

```json
{
  "conversationNaming": {
    "enabled": true,
    "provider": "my-provider",
    "model": "my-naming-model",
    "thinkingLevel": "low"
  }
}
```

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

<a id="automemory"></a>
#### autoMemory（Auto Memory）

`Auto Memory` 是 global 的，默认关闭。在 `/settings` 中启用后，MyHarness 会要求选择一个可用 model，以及该 model 支持的 thinking level。随后 MyHarness 会：

1. 在 main model 收到新的 user request 前（包括新 session 的第一次 request），通过有边界的本地文本匹配选择相关的已保存 memories。Recall 不会发起 blocking model request；
2. 将这些 memories 作为 hidden、low-priority context 添加。它们不能覆盖 system、global、project 或当前 user instructions，也不会授予 tool permissions；
3. Task 完成后，只等待待处理任务安全写入当前 Conversation 的 `memory/maintenance.json`，不等待记忆模型。后台合并短时间内的任务快照，逐批处理尚未提取的 conversation delta，提取持久的 preferences、corrections、project facts 和 references；
4. 当前 Workspace 的新增或实质更新累计达到 5 条时立即后台整理；不足 5 条但大于零时，从第一条待整理变化起满 3 小时整理，后续变化不重置计时。重复且无变化的写入不计数，整理自身的修改不计入下一轮。计数与起始时间保存在 `state.json`，成功整理后清零，失败保留；旧 session-count 状态按当前 active memories 的更新时间恢复。存活的 persisted Chat runtime 每 30 秒检查到期任务，无需新消息；关闭服务期间不运行，打开 Chat 后恢复检查。整理只读取该 runtime 可见的 Global、Workspace 和当前 Conversation，超出输入保护的记忆分批全部检查，不跨 Conversation 提升归属。被替代条目和更新前的版本保存到所属层的 `archive/`，不永久删除。

选中的 model 用于后台 extraction 和 consolidation，不用于同步 recall。Extraction 收到有边界的 conversation delta 和 manifest，没有 project tools。启用后会将 conversation content 发送给选中的 model，产生额外 usage，但聊天和重启不等待这些请求。待处理快照在落盘前过滤常见敏感值；不包含 tools 和图片。后台失败最多尝试三次，延后重试；连续失败保留快照并显示安静状态，不弹出 transcript warning。重启/替换 runtime 时取消模型请求，重新打开对应 Chat 后继续未完成工作；尚未打开的 Chat 不会自动创建 runtime 来处理任务。

Recall 搜索三个所属层的全部 active entries，而不是只搜索最近 200 条；本地词项稀有度和文本长度参与排序，按相对相关性筛选并在同层去重。仍使用 20 KB 作为异常保护，不是精确 Token 预算，也不是语义向量检索。

记忆文件的 frontmatter 另有两个可选字段，缺失时按默认处理，旧文件无需迁移：`importance`（`high` / `normal` / `low`，排序乘子 1.3 / 1.0 / 0.7，缺失按 `normal`）和 `triggers`（2–6 条用户真实会说的口语短语，单条最多 60 字节）。当前消息命中某条记忆的 trigger（整句包含，或中文双字组重叠，英文要求整词命中）时，该记忆直接入选，按命中条数排序、最多 3 条，不受相对相关性筛选限制；其余记忆仍走上面的词项排序，得分乘以 `importance` 乘子。排序是只读的本地函数（`selectMemoriesForQuery`），Recall 与 `memory_search` 共用，不写任何文件，也没有使用计数或时间衰减。抽取和整理时模型看得到已有的 `importance` 与 `triggers`；更新条目时省略它们（或给空数组）会保留原值，用户手写的标注不会被抹掉。

Global 层可以有一条固定的常驻画像 `global/用户画像`（`type: user`、`importance: high`，六节：称呼与身份背景、沟通与语言偏好、工作与授权习惯、长期环境与工具事实、正在推进的事、被纠正过的行为与教训）。它只由整理器整篇重写；抽取器对它的写入会被忽略，模型的删除操作也会被忽略；整理器不会凭空创建它，文件需先存在。存在时它每轮都放在 recall message 的最前面，不参与普通排序，因此不会重复注入。单条记忆正文上限为 8 KB（读取与写入一致），画像整篇也必须在这个上限内。

主对话模型还有两个只读工具 `memory_search` 和 `memory_get`（Coding 与 General 都可用，子智能体不可用；Auto Memory 关闭或会话不持久化时只返回一句说明）。`memory_search` 不带 `query` 时列出记忆目录（`id | name | description | importance | type | scope | updatedAt`，按更新时间倒序，超出 16 KB 时截断并标注），带 `query` 时用与 Recall 相同的排序返回摘要，不含全文；`memory_get` 按 id 取全文（一次最多 5 个），未找到的 id 返回说明而不报错，不返回 `archive/` 下的归档版本。每次模型请求过滤旧轮次的 recall message，仅保留当前 user message 后的 recall，磁盘对话历史不改写。更新使用乐观冲突检测，已有内容变化后重新提取；相同内容不重复归档。新记忆记录提取来源的 Workspace、Session 和末条 Entry ID。这是批次来源，不是逐句证据标注；没有专用的对话历史搜索工具（记忆工具只查长期记忆，不查历史对话）。Automatic memory 只适用于 persisted sessions；`--no-session` 不读写 long-term memory。

Memory Markdown files 是 source of truth：

- 当前 Data 内跨工作区共享的 Global memory：`<data>/memory/*.md`；
- Workspace memory：`<data>/workspaces/<workspace-id>/memory/*.md`；
- Conversation memory：`<data>/workspaces/<workspace-id>/sessions/<session-id>/memory/*.md`；
- 每层的 `archive/` 保存更新前或整理替代的旧版本，默认不参与 recall；
- 全局引用索引和 extraction state：`<data>/memory/index.json` 与 `state.json`，Workspace 的 `memory/index.json` 汇总自己的记忆和对话记忆，不复制正文。

Recall 只读取 Global、当前 Workspace 和当前 Conversation 的 active Markdown，不读取兄弟对话、其他工作区、归档或待归属记忆。Scope 为 `global|workspace|session`；旧模型输出的 `project` scope 作为 Workspace 的兼容别名。没有 Workspace 的持久化对话使用现有 `unbound` 容器；custom/legacy flat Session 没有 Workspace identity 时也使用该容器及当前 Data root。

首次读取/提取或打开 Files → Memories 时，将旧 Agent memory 复制到当前 Data；Global 进入总层，旧 project hash 根据保留的 Workspace metadata rootPath 匹配。无法唯一匹配的保存在 `<data>/memory/pending/`，不参与 recall；旧 index/state 保存到 `memory/legacy/` 作为迁移记录，不沿用旧 project consolidation 分组。每个来源 Agent directory 有独立迁移标记，防止重复导入；旧文件不会删除。迁移之后只在新 Data 中正常读写。

删除 Chat（包括勾选删除产出）仍保留其 `memory/`；移除 Workspace 不删除记忆，保留原 ID 归属。Files → Memories 可按当前 Chat、Workspace、所有 Workspace 汇总查看 active/归档，包括来源已删除或 Workspace 已取消登记的数据；恢复归档前保存当前版本，恢复操作不删除原归档。当前没有永久删除记忆的 UI/API；不会因自动整理或删除其他数据而隐式永久删除。

关闭该 setting 会停止安排新的 extraction 和 recall，但不会删除已有 memory files 或待处理快照。已经开始的请求仍可能完成；runtime 释放时取消。写入前，MyHarness 会拒绝 private keys，并 redacts 常见的 API-key、token、password、secret 和 Bearer credential patterns。这是 defensive filter，不能保证检测出所有可能的 secret formats。

```json
{
  "autoMemory": {
    "enabled": true,
    "provider": "anthropic",
    "model": "claude-opus-4-6",
    "thinkingLevel": "high"
  }
}
```

#### subAgent

`Sub Agent` 是 global 设置。启用后，在 `/settings` 中 MyHarness 会要求选择一个可用 model，以及该 model 支持的 thinking level。在启用开关前面还有一个模式选择器（只读 / 读写，默认只读）；切换只影响之后新派出的子代理，正在运行的子代理不变；保存后当前会话的 `agent`/`workflow`/`ultracode` 工具说明会立即按新模式重建，主 AI 不必等到新会话才知道子代理能否写入。之后 main AI 可以使用：

- `agent` 将一次 investigation 拆分为多个并行 Explore tasks。数量上限由 `maxTasks` 配置：默认 `3`，可在设置面板“子智能体（Explore）”行内或 `settings.json` 中调整，取值范围 1–18（18 是协议硬上限）。每次调用都按保存后的最新值生效，不需要重启会话。
- 每个 delegated Explore task 默认没有总时间上限（`totalRuntimeLimitMs` 以毫秒为单位；`0` 表示无上限，`taskTimeoutMs` 是兼容旧配置的别名）。默认 Stall Timeout 为 10 分钟：它只在没有有效新进展时计时，检测到新的工具范围或结果会重置计时器。
- `maxTurns` 默认 `0`（无限制）；达到正数上限会保留 `partial` 结果。`stallTimeoutMs` 为 `0` 时关闭 stall watchdog。硬停止只保留给真实不可用进展：stall watchdog、墙钟超时、`maxTurns` 上限和取消；`noProgressDetection` 和 `repeatedOperationDetection`（默认开启）控制的是向运行中的子 Agent 注入“收敛提醒” steering 消息的强度（重复操作、连续工具失败、几轮无新信息按阈值周期性提醒），计数本身不再终止任务。
- 带 `questions` 的 Explore task 要求子 Agent 逐项回答并在报告末尾给出 `## Completion checklist`；报告缺清单或声明了未回答问题时，任务记为 `partial`（`stopReason: "incomplete_answer"`）并列出未回答项。
- `workflow` 运行一个或多个 sequential phases，每个 phase 可以包含多个并行 Explore tasks。第一个 phase 之后的每个 phase 都会收到上一阶段的 results。

`/workflow` 和 `/ultracode` prompt commands 分别指示 main AI 使用 `workflow` 和 `ultracode` tools。`/ultracode` 使用更严格的中文 instructions；如果第一次 Ultracode run 不够，会继续执行后续 run。所有 phase 和 task descriptions 都由 main AI 决定；child agents 不能再创建更多 agents。`workflow` 和 `ultracode` 与 `agent` 共用同一套子代理运行时，因此也跟随同一个模式开关：读写模式下它们派出的子代理同样只能在各自 worktree 内写入，两个工具的描述、参数提示和系统提示里的相关句子会按模式改写；只读模式下这些文字与开关加入之前逐字一致。

只读模式（`mode: "read-only"`，默认，即历史行为）：Child agents 可以使用 read、grep、find、ls 和 Bash，但不能使用 edit 或 write。它们的 Bash 命令由 delegated read-only guard 按 shell 序列段判定：每个段（管道、`&&`、`;`）都是允许的只读检查命令时放行，诊断重定向（如 `2>/dev/null`）不影响判定；命中的命令会被拦截并返回带 `[read-only-guard]` 标记的具体原因，这类拦截不计入子 Agent 的连续工具失败统计。guard 基于可执行命令白名单和危险选项检查，面向 inspection，而不是严格的 read-only security boundary。

读写模式（`mode: "read-write"`）：子代理在只读六个工具之外额外获得 edit、write 和 pwsh（与 main 写入配置中的写入/执行工具一致）。每个读写子代理任务各自从当前分支最新提交创建一个独立 Git Worktree（与副本功能同一套创建逻辑，位于 `<agentDir>/worktrees/<仓库名>/<分支名>`），工作目录锁定在该 worktree 内。创建后，派出时工作区里尚未提交的改动（修改、删除和未跟踪文件，不含被 `.gitignore` 忽略的文件）会按磁盘上的当前内容复制进去，并在这个 worktree 自己的分支上记成一个 workspace snapshot 提交（用 `commit-tree` 写入，不触发 hook）：子代理看到的文件和主 Agent 此刻看到的一致，`git status` 一开始是干净的，之后列出的只有子代理自己的改动，结果里的改动文件列表也只算这些；在 worktree 里 `git diff` 即是子代理的改动。符号链接、子模块/嵌套仓库和超过 50 MB 的单个文件带不进去，会写进任务提示并出现在结果的「未解决」里；派出之后主 Agent 再改的文件不会同步进去，主工作区的绝对路径在 worktree 内读不到（子代理按相对路径访问同一份文件）；文件工具的 `path` 参数由 delegated write guard（`[delegated-write-guard]` 标记）在工具层强制检查，越出 worktree 直接拒绝并在结果中报告，不弹任何确认框。两种模式共同的硬规则：子代理不能使用任何派发工具（agent/workflow/ultracode 及同名动态工具在运行时被 `[nested-dispatch-guard]` 拒绝）；读写子代理永远不能 `git commit`、`git push`、`git merge`、`git add`，也不能执行改写历史或删除内容的命令（`reset --hard`、`clean`、`push --force`、`branch -D`、`worktree remove` 等）；这些限制在工具层拦截，无法通过参数解锁，提交由 main Agent 在用户明确要求下自行完成。任务结束时：没有任何改动的 worktree 自动清理（同时删除自动创建的分支）；有未提交或未跟踪改动的 worktree 永远保留，并在结果中返回 worktree 路径、分支名和改动文件列表，改动摘要与测试结果由子代理报告。工作区不是 Git 仓库（或没有 main 主 worktree/没有任何提交）时，派出读写子代理会直接报错，只读模式不受影响。shell 的边界是工具层对每个命令段的解析检查：git 只放行只读子命令；cd 目标必须留在 worktree，且 `Set-Location`/`Push-Location`/`pushd`/`popd` 等切换目录的命令、嵌套 shell 与内联代码执行（`bash -c`、`pwsh -Command`、`cmd /c`、`node -e`、`eval`、`iex`、`xargs`、远程 shell 等能把边界检查带出命令解析范围的手段）被直接拒绝；命令参数中的绝对路径、主目录（`~`/`$HOME`/`%USERPROFILE%`）、无法确认的环境变量路径和重定向目标都会接受 worktree 包含性检查。管道、`&&`、`;` 逐段检查；无法安全解析的结构一律拒绝。这不承诺操作系统级沙箱（例如脚本文件内部的写操作无法逐行审查）；文件工具的路径限制是硬约束。被拦截的操作在工具结果中以 `[delegated-write-guard]` 标记报告，不计入子代理连续工具失败统计。

```json
{
  "subAgent": {
    "enabled": true,
    "mode": "read-only",
    "provider": "anthropic",
    "model": "claude-opus-4-6",
    "thinkingLevel": "high",
    "maxTasks": 3,
    "taskTimeoutMs": 0,
    "totalRuntimeLimitMs": 0,
    "maxTurns": 0,
    "stallTimeoutMs": 600000,
    "noProgressDetection": true,
    "repeatedOperationDetection": true
  }
}
```

#### webSearch（Web Search）

`Web Search` 默认关闭。在 `/settings` 中启用后，当前 Agent 才会获得 `web_search` 和 `web_fetch`；关闭只移除工具，不删除已有 Session、Tool Result 或历史记录。

搜索和网页读取都由 MyHarness 内置完成，不需要部署或填写任何外部服务地址。用户可以选择搜索引擎、浏览器兜底和四个数量：

| 字段 | 含义 | 范围 | 默认 |
| --- | --- | --- | --- |
| `engines` | 启用的搜索引擎：`google`、`bing`、`duckduckgo`、`brave`、`brave_api`（需要 API Key） | 任意组合 | `["google", "bing"]` |
| `browserFallback` | 轻量请求被拦截时，是否允许用本机浏览器（MyHarness 专用配置）打开真实的搜索页或网页 | On / Off | `true` |
| `browser` | 兜底用哪个浏览器；`auto` = Firefox、Chrome、Edge 中第一个已安装的 | `auto` / `firefox` / `chrome` / `edge` | `"auto"` |
| `useBrowserCookies` | 是否把日常浏览器的 Cookie 复制一份到专用配置，用来读取已登录的网站 | On / Off | `false` |
| `pagesPerSearch` | 每次搜索后自动读取前几个结果的网页正文；0 = 只返回结果 | 0–10 | 3 |
| `maxUrlsPerFetch` | 一次 `web_fetch` 最多读取几个网址 | 1–20 | 10 |
| `fetchConcurrency` | 同时下载网页的最大数量（所有联网工具共享） | 1–8 | 4 |
| `maxRedirects` | 直接读取网页时最多跟随的跳转次数；0 = 不跟随。达到上限时产生 `too_many_redirects`，启用浏览器兜底时自动改用浏览器；无法兜底时说明跳转上限及可能的鉴权循环或配置问题 | 0–20 | 5 |

```json
{
  "webSearch": {
    "enabled": true,
    "engines": ["google", "bing"],
    "browserFallback": true,
    "browser": "auto",
    "useBrowserCookies": false,
    "pagesPerSearch": 3,
    "maxUrlsPerFetch": 10,
    "fetchConcurrency": 4,
    "maxRedirects": 5
  }
}
```

`browserFallback` 使用 MyHarness 专用的浏览器 profile，与用户自己的浏览器隔离，并复用该 profile 中的 Cookie/Session；搜索页和网页正文（直接请求遇到 403、人机验证、登录页等）都会用到它。浏览器未安装、无法连接或 profile 被占用时会在 Diagnostics 中说明原因；如果页面仍要求 CAPTCHA、登录或 consent，交互界面会提示用户在弹出的浏览器窗口完成，完成后自动继续，无人值守模式返回 `challenge_required`。`useBrowserCookies` 只复制 Cookie，不修改用户自己的浏览器配置，限制见 Web Search 文档。

超出范围的数字按最近的上下限处理。Brave Search API Key 不在 `settings.json` 中，保存在 agent 目录的 `web-search-keys.json`。旧的 `searxngUrl`、`crawl4aiUrl`、`engineMode`、`scope`、`allowedDomains`、`parallelPages`、`searchRounds` 和缓存 TTL 字段的迁移方式、各引擎的稳定性说明、Tool schema、缓存、超时和取消见 [Web Search 文档](web-search.md)。

#### visionAssistant

`Vision Assistant` 是 global 设置，默认关闭。main-model picker 和 vision-model picker 使用不同的 title 和 capability labels：

- main-model picker 会列出所有可用 models，并标记为 text-only 或 text-and-image。Vision Assistant 关闭时，支持 multimodal 的 main model 会直接收到 images。
- vision-model picker 会列出 enabled Providers 中 credentials 可用的 eligible models。已经确认支持视觉的 models 可以直接选择；unknown 或之前测试失败的 custom models 在选择时会打开 capability test。明确声明为 text-only 的 models 不会列出。

单独的 unknown-model detection screen 可以发送一个内置的小型 PNG，检查 model 能否读出其中固定的数字和颜色。这个 request 使用所选 Provider 的 current API key，可能产生少量 Provider 费用。成功或失败的 probe result 会全局缓存到 `~/.myharness/agent/settings.json` 中的 `visionCapabilityTests`；network、authentication、balance、timeout 和其他 request errors 不会被缓存为“不支持 image”。

启用 Vision Assistant 后，MyHarness 会要求选择该 visual model 支持的 thinking level。

对于每个新的 user image 或 tool-result image，MyHarness 会把 image 和数量受限的相关 task text 发送给 selected vision model，且该 request 不提供 tools。较大的 image collection 会拆分为多个 batch：每次最多 8 张 images，base64 payload 约不超过 18 MB，最后按顺序合并。已完成的大 batch report 会 checkpoint 到当前 session directory，因此中断后重试可以复用已完成的部分。Checkpoint 保存的是 analysis text，不是 source files 的副本。main model 收到的是生成的中文 text analysis，而不是原始 image。即使 main model 自身支持 images 也遵循这一规则，因此该 setting 始终决定哪个 model 能看到 images。

结果会保存到 session，并以 compact status 显示。按 Ctrl+O 可以展开完整 report。相同的 image-and-task request 会复用 session-local cache。Vision request 失败时会明确显示失败，并告诉 main model image analysis failed；MyHarness 不会默默假装 main model 已经看到了 image。

`Block images` 的优先级更高。启用后，MyHarness 不会把 images 发送给 main model 或 Vision Assistant。

本地 `@file` arguments 和内置 `read` tool 共用同一条 preprocessing pipeline：

- JPEG/JPG、PNG、WebP、GIF 和 BMP 可以直接处理。SVG、HEIC/HEIF、AVIF、TIFF、APNG、JPEG XL、PSD 和 PSB 会先转换为 PNG。
- PDF text 和 page images 会逐页处理到 `~/.myharness/agent/document-corpus/<document-id>/`。每页都会保留 source file name 和 original page number。Vision Assistant 关闭时，最多可将 12 个均匀分布的 pages 作为 direct preview 附加；persistent manifest 始终覆盖所有成功处理的 pages。
- DOCX 和 ODT text 会按 document structure/headings 分隔；XLSX 和 ODS 会保留 worksheet labels；PPTX 和 ODP 会保留 slide labels。RTF 会分隔为 text fragments。同一个 unchanged file 以不同 preview options 重新打开时，corpus access token 保持稳定。Embedded images 会单独写出，最多 8 张会作为 direct previews 附加。
- AVI、M4V、MKV、MOV、MP4 和 WebM 会转换为最多 8 个均匀分布的 keyframes。Audio tracks 不会处理。

启用 Vision Assistant 后，它会分别读取每个 document manifest，绝不会在同一个 request 中混用不同 documents 的 pages；每个 request 最多处理 4 个 document pages，同时遵守 18 MB request budget。缺少必要 source labels 的 report 会丢弃，并逐个 unit 重试。因 model token limit 停止的 output 会拆成更小的 requests，不会直接当作完整结果接受。每个完成的 batch 都会 checkpoint。超过 4 个 documents 或 16 个 visual units 的 collections 会作为 persistent background jobs 运行，并在 MyHarness 重启后继续；较小的 documents 保持 synchronous，这样 analysis 可以出现在同一个 answer 中。Preprocessing failures、unreadable pages 和 incomplete visual batches 会产生 `部分完成`，而不是虚假的成功结果。

完整的 extracted text 和逐页 visual transcription 会与 manifest 保存在一起。Large collection notices 会包含 corpus search directory：main model 应使用 `grep` 定位匹配的 `fulltext.md` files，再用 `read` 获取 exact passages。Completion notices 会提供 aggregate counts，而不是每个 document 各生成一段占用 prompt 空间的长文本。Legacy DOC/XLS/PPT files 和 audio files 会报告为 unsupported，不会被误读为 UTF-8 text。

将 directory 作为 `@` argument 传入时，会递归发现支持的 modern documents、普通及转换后的 image formats、PSD/PSB 和 video files。某个 item missing、unreadable、empty 或 malformed 时会单独报告，剩余 files 继续处理。超过 4 个 files 的 collections 不附加 document previews。超过 20 个 documents 的 collections 会使用一个 authenticated collection index，而不是嵌入每个 document notice，避免 initial model context 随整个 collection 增长。

默认的 single-file safety limits 为：images 和 modern Office documents 128 MB，PDF 和 PSD/PSB 256 MB，video 20 GB。这些限制用于避免 malformed 或异常大的单个 file 耗尽 memory；application callers 可以显式覆盖。Office ZIP extraction 另外限制为 256 MB decompressed data 和 5,000 entries。`Block images` 会跳过 visual conversion work，而不是先转换 images 再丢弃。

启用此 feature 会将 image 和相关 task text 发送给 selected Provider。Vision model 不会收到 tools，不能运行 commands、修改 files 或创建 sub-agents。Image text 会被当作 untrusted data，而不是 instructions。

```json
{
  "visionAssistant": {
    "enabled": true,
    "provider": "anthropic",
    "model": "claude-opus-4-6",
    "thinkingLevel": "medium"
  },
  "visionCapabilityTests": {
    "custom/unknown-model": {
      "status": "supported",
      "testedAt": 1780000000000
    }
  }
}
```

#### gitIntegration

`Git` 默认关闭，只作用于当前 project。在 `/settings` 中启用后：

1. 检查是否安装了 Git，以及当前 directory 是否已经是 repository。
2. 如果不存在 repository，在运行 `git init` 前先询问。
3. 将现有 local 或 global Git name 和 email 显示为可编辑的 defaults；保存时只写入当前 repository 的 `.git/config`。
4. 显示首次 baseline 包含的 files，并在运行 `git add` 和 `git commit` 前先询问。

task 修改 files 后，MyHarness 会发布已验证的结果，然后提供 `Save` 或 `Later`。`Save` 只会 preview 并 commit 当前 task 通过 `edit` 和 `write` calls 修改过的 paths。项目 repository 之外的 files（例如 desktop 上的 paths）不在 checkpoints 覆盖范围内：写入这些 files 不会 snapshot，restore 也不会触碰它们。Git integration 的 checkpoint/save 流程不会自动 push、pull、fetch、clone、创建 remote 或上传 commit；只有用户明确执行 `/push` 时，MyHarness 才会对当前 branch 的真实 upstream 执行受限 Push，并在支持的 GitHub Actions 连接可用时验证远端 SHA 与当前 commit 的 branch-push CI。无法验证 CI 时会保留真实未确认状态。关闭此 setting 只会停止 MyHarness 自动使用 Git，不会删除 `.git`、commits 或 file changes。

启用 Git 后，task changes 会通过 repository 的 task checkpoint 进行跟踪。

任务出错、被中断或 Provider/Tool 失败后，MyHarness 只显示真实错误并原样保留工作区，不会自动弹出恢复选择，也不会拦截下一条消息；checkpoint 仍有未处理的修改时，可以随时输入 `/undo` 选择保留或只撤销这次任务的修改；输入 `/restore` 则丢弃所有未提交内容并退回最新提交。如果 Git 无法创建 checkpoint（例如仓库里有 Windows 保留名文件 `nul`、没有提交的嵌套仓库或权限问题），MyHarness 会显示 Git 原始错误和涉及的路径，本轮不再重复尝试，Agent 继续读写文件、运行命令和接收消息，只是本轮修改无法通过 `/undo` 撤销。MyHarness 不会自动删除或清理这些文件。

Project `.myharness/settings.json`:

```json
{
  "gitIntegration": {
    "enabled": true
  }
}
```

<a id="ui--display"></a>
### UI & Display（UI 与显示）

| Setting | Type | Default | 说明 |
|---------|------|---------|-------------|
| `theme` | string | - | 旧终端 Theme 名称；仅保留持久化兼容，不控制 Web 配色。 |
| `externalEditor` | string | `$VISUAL`，其次 `$EDITOR`，最后 Windows 上的 Notepad 或其他系统上的 `nano` | Ctrl+G 使用的 external editor command；优先级高于 environment variables |
| `quietStartup` | boolean | `false` | 隐藏 startup header |
| `defaultProjectTrust` | `"ask"\|"always"\|"never"` | `"ask"` | Project Trust 的 fallback behavior。仅适用于 global setting |
| `collapseChangelog` | boolean | `false` | updates 后显示 condensed changelog |
| `enableInstallTelemetry` | boolean | `true` | 首次 install 或检测到 changelog update 后发送 anonymous install/update version ping。不控制 update checks |
| `enableAnalytics` | boolean | `false` | opt-in analytics data sharing。目前只会在 experimental first-time setup（`MYHARNESS_EXPERIMENTAL=1`）期间询问 |
| `trackingId` | string | - | Analytics tracking identifier；开启 `enableAnalytics` 时生成 |
| `doubleEscapeAction` | `"fork"\|"tree"\|"none"` | `"tree"` | 保留用于 compatibility 的 setting。当前 interactive escape handler 不会触发 tree 或 fork actions。 |
| `editorPaddingX` | number | `0` | Input editor 的 horizontal padding（0-3） |
| `outputPad` | `0\|1` | `1` | User messages、assistant messages 和 thinking 的 horizontal padding（0 或 1） |
| `autocompleteMaxVisible` | number | `5` | Autocomplete dropdown 的最大可见 items 数量（3-20） |
| `usageRanking` | object | `{}` | 用于给 top-level slash commands 和第一层 `/settings` items 排序的 global usage counters；内部 option lists 保持定义顺序 |
| `showHardwareCursor` | boolean | `false`（或 `MYHARNESS_HARDWARE_CURSOR=1`） | 旧终端光标设置；仅保留持久化兼容 |

使用 VS Code 时加入 `--wait`，这样 editor 退出后 MyHarness 才会继续：

```json
{
  "externalEditor": "code --wait"
}
```

### Telemetry 和 update checks

`enableInstallTelemetry` 控制 anonymous install/update ping 和部分 Provider attribution headers。源码默认没有 telemetry endpoint；只有设置 `MYHARNESS_INSTALL_TELEMETRY_URL` 后才会发送 ping。

使用 `--offline` 或 `MYHARNESS_OFFLINE=1` 可以关闭这里提到的所有 startup network operations，包括 package update checks 以及 install/update telemetry。

### Network

| Setting | Type | Default | 说明 |
|---------|------|---------|-------------|
| `httpProxy` | string | - | 作为 `HTTP_PROXY` 和 `HTTPS_PROXY` 应用的 HTTP proxy URL。仅适用于 global setting。 |
| `worktreeShutdownGraceSeconds` | number | 首次沿用主退出值 | 管理启动的副本在最后一个标签页断开后等待多少秒退出；范围 0–3600，实际至少 5 秒保护刷新。与主设置独立保存，不影响主服务。 |
| `webShutdownGraceSeconds` | number | `10` | Web UI在最后一个浏览器页面断开后等待多少秒再退出；期间刷新或重新打开页面会取消退出。Web UI 设置范围为 0–3600 秒，为保护页面刷新与 SSE 重连，实际等待至少 5 秒（包括配置为 0 时）；配置超过 5 秒时按配置等待。宽限到期时若仍有任务在运行，倒计时推迟到任务停下才触发，不会中断进行中的工作。仅适用于 global setting，下一次倒计时开始时生效。见 [Web UI](web-ui.md)。 |

```json
{
  "httpProxy": "http://127.0.0.1:7890"
}
```

### Warnings

| Setting | Type | Default | 说明 |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true`（UI fallback） | Anthropic subscription auth 可能产生 paid extra usage 时显示 warning。字段缺失时 interactive UI 会使用 `true`，但 `getWarnings()` 不会强制设置 default。 |

```json
{
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

### Compaction

| Setting | Type | Default | 说明 |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | 启用 auto-compaction |
| `compaction.provider` | string | Current chat provider | 独立选择的 Compact Model 使用的 Provider |
| `compaction.model` | string | Current chat model | Compact Model ID；通过 `/settings` 与 `provider` 一起配置 |
| `compaction.thinkingLevel` | string | 未选 Compact Model 时为 current chat effort；选了 model 时不发送 | 独立的 Compact Thinking Effort，会限制在所选 model 支持的 levels 内；对于 non-reasoning models 不会发送 |
| `compaction.reserveTokens` | number | `16384` | 为 LLM response 预留的 tokens |
| `compaction.keepRecentTokens` | number | `20000` | summarization-overflow fallback 保留的 token budget；正常 compaction 使用最小的有效 tail |

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

### Branch Summary

| Setting | Type | Default | 说明 |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | 为 branch summarization 预留的 tokens |
| `branchSummary.skipPrompt` | boolean | `false` | session tree navigation 时跳过 `"Summarize branch?"` prompt（默认不生成 summary） |

### Retry

| Setting | Type | Default | 说明 |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | 启用 agent-level automatic retry，用于 transient errors |
| `retry.maxRetries` | number \| `"unlimited"` | `3` | agent-level retry 的最大 attempts；`"unlimited"` 表示不限次数，一直重试到成功或用户取消（Web 设置 → 网络的“自动重试次数”行可填任意整数或选无限） |
| `retry.baseDelayMs` | number | `2000` | agent-level exponential backoff 的 base delay（2s、4s、8s；逐次翻倍，单次最长 60s，保证大次数或不限次数时重试间隔不会无限增长） |
| `retry.networkMaxAttempts` | number | `2` | 网络失败（建连、首包、静默、断连）时，同一模型最多尝试几次，**含第一次**，范围 1–20；达到次数后切换到备用模型（`fallbackModel`），没有备用模型则结束。HTTP 类错误（429、过载等）不受影响，仍用 `retry.maxRetries` |
| ~~`retry.provider.timeoutMs`~~ | - | - | 已移除并被忽略：它是第二个整请求超时，会和首包超时叠加成两处各管一半。首包时限只有 `network.firstByteTimeoutMs` 一处 |
| `retry.provider.maxRetries` | number | `0` | Provider/SDK 额外 retry 次数；未设置时 MyHarness 对支持该选项的内置 adapter 只发起一次请求 |
| `retry.provider.maxRetryDelayMs` | number | `60000` | 失败前允许的最大 server-requested delay（60s） |

当 Provider 请求的 retry delay 超过 `retry.provider.maxRetryDelayMs`（例如 Google 返回 `"quota will reset after 5h"`）时，request 会立即失败并给出说明性 error，不会静默等待。设置为 `0` 可以关闭此 cap。

除非明确需要 provider-level retries，否则建议将 `retry.provider.maxRetries` 保持为 `0`。设置为大于 `0` 的值后，SDK/provider retries 可能会在 MyHarness 感知到之前处理 out-of-usage-limit errors；某些情况下这会让 agent 一直阻塞到 Provider quota reset。

Google Generative AI 和 Vertex adapter 会把 `maxRetries` 显式传给 Google SDK，并覆盖 SDK 默认的隐式 retry；`maxRetries` 表示额外重试次数，不是总请求次数。这两个 adapter 不再传 `timeoutMs`：Google SDK 的 `httpOptions.timeout` 覆盖整个请求（含流式读取），会把长回答在中途截断，它们的首包和静默限制只由全局 HTTP 分发器负责。Agent-level retry（`retry.maxRetries`）是另一层独立机制。

Agent-level retry 覆盖的临时故障包括：过载和限流（429、529）、服务端错误（500、502、503、504）、网关/CDN 回源故障（520、521、522、523、524、525、527、530，常见形式是 `520 status code (no body)`）、Bad Gateway / Gateway Timeout，以及连接重置、超时、DNS 临时失败（`ECONNRESET`、`ETIMEDOUT`、`EAI_AGAIN`）等网络中断。额度/余额耗尽不会重试。分类规则在 `packages/ai/src/utils/retry.ts`。

模型请求失败时，界面不会只显示原始状态码：终端、Web UI、print mode 和任务结束状态都会显示一段中文说明，先写原因（例如“模型服务提供商的网关与后端服务器之间连接异常（HTTP 520），并且没有返回任何错误说明”、网络超时、认证失效、额度不足），再写可以怎么处理，最后附上原始错误供排查。说明文案在 `src/providers/recovery/error-explanation.ts`，只影响显示，不影响是否重试。

#### fallbackModel（Fallback Model）

`fallbackModel` 是 global 设置，默认关闭，在 `/settings → Fallback Model`（Web UI 在 Settings 的 Agent 分组）中选择备用模型和思考强度：

```json
{
  "fallbackModel": { "enabled": true, "provider": "openrouter", "model": "some-model", "thinkingLevel": "medium" }
}
```

- 主模型请求失败，且 auto-retry 次数用完（或错误本身不可重试，例如认证失败、额度不足、模型不存在）、Provider recovery 也无法恢复时，当前任务自动切换到备用模型，带着同一段对话和已执行的工具结果继续；上下文超长不触发切换，仍由压缩处理。
- 备用模型有自己的一轮 auto-retry 次数。只有备用模型也失败时任务才结束，最终错误会分别写出主模型和备用模型各自的失败原因；备用模型无法启用（Provider 停用、没有 API Key、模型不存在）时也会说明原因。
- 切换只对当前任务有效：Session 中会记录模型变更，但 `defaultModel` 不变；任务结束后切回主模型，下一个任务仍先用主模型。任务进行中手动换了模型时不会被切回。

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

#### 网络超时与网络失败重试

原来的单个 `httpIdleTimeoutMs` 同时管着三种性质不同的等待，现在拆成互相独立的设置（上表 `network.*`、`retry.networkMaxAttempts`；Web 设置 → 网络与 Shell → “超时与重试”）：

| 失败 | 触发 | 分类（`ProviderErrorCategory`） | 错误码（沿 `error.cause` 链查找） |
| --- | --- | --- | --- |
| 建连超时 | 建立 TCP / TLS 超过 `connectTimeoutMs` | `connect_timeout` | `UND_ERR_CONNECT_TIMEOUT` |
| 无法连接 | 端口无监听、DNS 失败、证书错误等 | `connect_failed` | `ECONNREFUSED`、`ENOTFOUND`、`EAI_AGAIN`、证书类等 |
| 首包超时 | 请求发出后超过 `firstByteTimeoutMs` 还没有响应头 | `first_byte_timeout` | `UND_ERR_HEADERS_TIMEOUT` |
| 静默超时 | 响应头之后两段数据间隔超过 `streamIdleTimeoutMs` | `stream_idle_timeout` | `UND_ERR_BODY_TIMEOUT` |
| 断连 | 对端关闭连接（没有时限，是事件） | `disconnect` | `UND_ERR_SOCKET`、`ECONNRESET` 等 |
| 限流 / 过载 | HTTP 429 / 503 / 529 | `rate_limited` / `upstream_overloaded` | 状态码或错误体 `type`，不是网络错误 |
| 其他 | 以上都不是 | `other` | - |

- 分类只看 `error.cause` 链里的 `code`（以及 AggregateError 的子错误），**不看错误文字**。两个例外：SDK 自己的超时（`APIConnectionTimeoutError` / `AbortError`）没有错误码，响应头未到按首包超时，已到按静默超时；OpenAI 与 Anthropic SDK 会把文字里带 “timed out” 的 fetch 错误替换成没有 `cause` 的 `APIConnectionTimeoutError`，所以这两个 SDK 的 adapter 用 `captureFetchErrors()` 保留原始 fetch 错误再分类，否则建连超时和首包超时会混成一类。分类结果记录在失败消息的 `provider_failure` diagnostic（`packages/ai/src/utils/provider-failure.ts`），后端重试逻辑和界面共用同一份枚举。
- 首包时限只在一处生效：undici `headersTimeout`；OpenAI / Anthropic 系列 SDK 的请求计时器在响应头到达时就会停止，所以把同一个 `firstByteTimeoutMs` 传给它们（`providers/runtime/request-timeouts.ts`），两处是同一个数。Google / Vertex / Mistral / Bedrock 的 SDK 计时器会覆盖整个流，所以不传，只由分发器限制。SDK 层没有整请求超时。
- 网络失败有自己的次数上限 `retry.networkMaxAttempts`（含第一次，默认 2）。**还没有任何输出**时：等 1.5 秒后在同一模型上重试；达到上限后交给备用模型（沿用 `fallbackModel`，没有新建切换机制）；没有备用模型则结束。**已经有输出**（文字、思考或工具调用）后发生静默超时 / 断连：不自动从头重发，保留已显示内容，任务以 `terminalReason: "output-interrupted"` 结束，界面标“已中断”并给“重试”按钮（从当前状态继续，不重做已完成的步骤）。429、过载等 HTTP 错误沿用 `retry.maxRetries` 与指数退避，不受影响。
- 单次请求（单个模型）最长等待 ≈ `retry.networkMaxAttempts × (connectTimeoutMs + max(firstByteTimeoutMs, streamIdleTimeoutMs))`；设置页的只读行按当前数值显示这个估算。
- 每次尝试在 trace 的 `model-response` 事件里带一份 `network` 记录：尝试序号、分类、`cause.code`、`cause.message`、到响应头的时间、最长静默间隔、总耗时、输入 Token（供应商没报时用会话估算并标 `inputTokensEstimated`）；测不到的字段留空。最长静默间隔目前只有 `openai-completions` 适配器测量，其他适配器为空。
- Web 的 Commit 信息生成与测试副本命名（`routes-git.ts`）也走同一套时限和次数上限，再回到备用模型（`completeWithNetworkPolicy`）。
- 旧键 `httpIdleTimeoutMs` 和 `retry.provider.timeoutMs` 被忽略，读取时在日志里提示一次，不会自动换算成新值（旧数值同时管三种等待，没有可靠的换算）。默认值（10 秒 / 60 秒 / 60 秒 / 2 次）只是起点，之后按 trace 里的真实数据调整。

### Message Delivery

| Setting | Type | Default | 说明 |
|---------|------|---------|-------------|
| `steeringMode` | `"all"\|"one-at-a-time"` | `"one-at-a-time"` | Steering messages 的发送方式 |
| `followUpMode` | `"all"\|"one-at-a-time"` | `"one-at-a-time"` | Follow-up messages 的发送方式 |
| `transport` | string | `"auto"` | 支持多种 transports 的 Providers 使用的 preferred transport：`"sse"`、`"websocket"`、`"websocket-cached"` 或 `"auto"` |
| `network.connectTimeoutMs` | number | `10000` | 建连超时：TCP 连接加 TLS 握手，只在新建连接时生效（undici `connect.timeout`，`UND_ERR_CONNECT_TIMEOUT`）。1000–3600000 ms |
| `network.firstByteTimeoutMs` | number | `60000` | 首包超时：请求发出后到收到响应头（undici `headersTimeout`，`UND_ERR_HEADERS_TIMEOUT`）。同一个值也作为 OpenAI / Anthropic SDK 的请求时限。1000–3600000 ms |
| `network.streamIdleTimeoutMs` | number | `60000` | 静默超时：响应头之后两段数据之间允许的最长间隔，每收到一段重新计时，总时长不限（undici `bodyTimeout`，`UND_ERR_BODY_TIMEOUT`）。1000–3600000 ms |
| ~~`httpIdleTimeoutMs`~~ | - | - | 已移除并被忽略：旧的单一数值同时管三种不同的等待。读取设置时检测到该键只在日志里提示一次，**不会**自动换算成新键；新键没填就用上面的默认值 |
| `websocketConnectTimeoutMs` | number | - | 支持 WebSocket transports 的 Providers 使用的 WebSocket connect/open handshake timeout，单位为 milliseconds。未设置时使用 SDK default。设置为 `0` 可关闭 |

### Terminal & Images

| Setting | Type | Default | 说明 |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | 在 terminal 中显示 images（如果 terminal 支持） |
| `terminal.imageWidthCells` | number | `60` | Terminal cells 中 preferred inline image width |
| `terminal.clearOnShrink` | boolean | `false`（或 `MYHARNESS_CLEAR_ON_SHRINK=1`） | 内容缩小时清除空 rows（可能产生 flicker） |
| `terminal.showTerminalProgress` | boolean | `false` | Agent 工作时，在 terminal 支持的情况下输出 OSC 9;4 progress indicators |
| `images.autoResize` | boolean | `true` | 将 images resize 到最大 2000x2000 |
| `images.blockImages` | boolean | `false` | 阻止所有 images 发送给 LLM |

### Shell

| Setting | Type | Default | 说明 |
|---------|------|---------|-------------|
| `shellPath` | string | - | Custom shell path（例如 Windows 上的 Cygwin）；支持以 `~` 开头表示 home directory |
| `shellCommandPrefix` | string | - | 每条 bash command 使用的 prefix（例如 `"shopt -s expand_aliases"`） |
| `npmCommand` | string[] | - | 用于 npm package lookup/install operations 的 command argv（例如 `["mise", "exec", "node@20", "--", "npm"]`） |

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` 用于所有 npm package-manager operations，包括 install、uninstall，以及 git packages 内部的 dependency install。User-scoped npm packages 安装到 `~/.myharness/agent/npm/`；project-scoped npm packages 安装到 `.myharness/npm/`。请按 process 实际启动所需的形式填写 argv-style entries。配置 `npmCommand` 后，git package dependency installs 使用 plain `install`，避免在 wrappers 或 alternate package managers 中传入 npm-specific flags。

#### 后台任务与会话状态管理（Background Jobs & Shell State）

`bash` 与 `pwsh` 工具内建支持后台运行（`run_in_background`）与跨轮次状态保持（`preserve_state`），并配套 `job_list`、`job_output`、`job_kill` 三个作业管理工具。这些均为 shell tool 的内建能力，默认启用，无需在 `settings.json` 中额外配置。

- **后台运行与作业管理**：
  - `bash` / `pwsh` 传入 `run_in_background: true` 时，命令在后台异步执行并立即返回分配的 `taskId`（形如 `job-xxxxxxxx`）。
  - `job_list`：列出当前会话的所有后台作业及其运行状态（`running`、`completed`、`failed`、`killed`、`timed_out`）、退出码与命令。
  - `job_output`：只接收 `taskId`，返回指定后台作业自上次调用以来的增量输出，每次调用最多返回 50KB（未读完时会提示再次调用以继续获取后续内容）。无 `tail` 或 `follow` 参数。
  - `job_kill`：接收 `taskId`，终止后台作业及其完整子进程树（Windows 上利用 `taskkill /F /T /PID`，POSIX 上利用进程组 `SIGKILL`），并确认进程已终结。
  - **保护策略与生命周期**：
    - 单会话并发上限：每会话最多同时运行 8 个后台作业，超出时拒绝启动；历史完成作业保留最多 100 条记录，超限时自动淘汰并物理删除最早终结作业的日志。
    - 运行时间上限：后台任务不受前台单次调用的超时限制，但受全局 24 小时硬上限约束，超时后状态变为 `timed_out`。
    - 磁盘日志保护：输出实时流式写入系统临时目录的磁盘日志文件，单个作业累积输出上限为 64MB，超出部分停止写入并标记 `logTruncated: true`。
    - 退出清理：进程退出时（`process` exit 钩子），同步杀死所有存活的后台子进程树，并同步删除所有任务的临时日志文件。
    - 派生子代理拦截：只读与读写模式的派生子代理（subagent sessions）均禁止调用 `run_in_background`，由 guard 严格拦截；子代理工具白名单中不包含 `job_*` 工具。

- **跨轮次状态保持（Preserve State）**：
  - `bash` / `pwsh` 传入 `preserve_state: true` 时，该命令执行后的工作目录变更（`cd` / `Set-Location`）与环境变量（`export` / `$env:VAR`）将保存在会话级状态存储中，自动注入该会话后续携带 `preserve_state: true` 的命令中。后台任务在启动时读取已保存状态，但不回写状态。
  - 只有退出码为 0 的成功执行才会更新会话状态；非零退出码命令不破坏已有状态，且状态探针输出会被自动剥离，不污染返回值。
  - 派生子代理禁止调用 `preserve_state: true`。

### 提问与待办工具（Ask User & Todo）

`ask_user_question` 与 `todo_write` 对主智能体默认启用，无需在 `settings.json` 中额外配置；子智能体不可用。

- **`ask_user_question`**：模型需要用户做选择或补充无法推断的关键信息时，在界面弹出选择框或输入框。一次最多 4 个问题，每题 2 到 6 个选项，默认附加“其他（自己输入）”。用户关闭弹窗时，工具返回“用户没有回答”，不会编造答案；没有可交互界面（SDK 或无头运行）时直接报错 `NO_INTERACTIVE_UI`。
- **`todo_write`**：每次传入完整清单并整张替换，最多 50 项，同一时间只能有一项 `in_progress`。清单只保存在对话记录的工具调用中，不写入单独的文件。

### 可选文件工具（apply_patch）

`apply_patch` 是可选的内置工具，默认不启用，不在默认工具集合中。它用一段补丁文本一次新增、删除、修改、移动多个文件：补丁要么全部写入，要么一个文件都不写。

启用方式与 `grep`、`find`、`ls` 相同：把 `apply_patch` 写进显式工具白名单。CLI 使用 `--tools`（或 `-t`），SDK 使用 `tools` 选项。白名单会替换默认集合，所以要把仍需要的工具一起列上，例如 `--tools read,bash,edit,write,apply_patch`。`--exclude-tools`（`-xt`）仍可排除它。子智能体不会获得 `apply_patch`。

- 修改或删除已存在的文件前，必须先用 `read` 读取。没读过的文件，或读后被外部改过的文件，会被拒绝，规则与 `edit`、`write` 相同。新增文件不需要先读。
- 补丁里任何一处对不上，都不写任何文件；错误信息会指出是哪个文件的哪一块。
- 写入过程中出错时，已写入的文件会尽量恢复到修改前的内容；返回的错误信息会列出已恢复、无法恢复和未写入的文件。
- 修改已存在的文件时保持原文件的换行风格（CRLF）和 BOM。

### Sessions

| Setting | Type | Default | 说明 |
|---------|------|---------|-------------|
| `sessionDir` | string | Data Framework 的 `data/workspaces/<workspace-id>/sessions/<session-id>/` 布局 | 覆盖默认 Session 存储 directory。支持 absolute paths、relative paths 和 `~`；未设置时使用 Data Framework 布局。 |

```json
{ "sessionDir": "data/custom-sessions" }
```

多个来源同时指定 session directory 时，优先级依次为 `--session-dir`、`MYHARNESS_CODING_AGENT_SESSION_DIR`，最后是 settings.json 中的 `sessionDir`。

### Model Cycling

| Setting | Type | Default | 说明 |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Ctrl+P cycling 使用的 model patterns（格式与 `--models` CLI flag 相同） |

```json
{
  "enabledModels": ["claude-*"]
}
```

### Markdown

| Setting | Type | Default | 说明 |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Code blocks 的 indentation |

### Resources

这些 settings 定义从哪里加载 extensions、skills、prompts 和 themes。

`~/.myharness/agent/settings.json` 中的 paths 相对于 `~/.myharness/agent` 解析；`.myharness/settings.json` 中的 paths 相对于 `.myharness` 解析。支持 absolute paths 和 `~`。

| Setting | Type | Default | 说明 |
|---------|------|---------|-------------|
| `packages` | array | `[]` | 从中加载 resources 的 npm/git packages |
| `extensions` | string[] | `[]` | Local extension file paths 或 directories |
| `skills` | string[] | `[]` | Local skill file paths 或 directories |
| `prompts` | string[] | `[]` | Local prompt template paths 或 directories |
| `themes` | string[] | `[]` | Local theme file paths 或 directories |
| `enableSkillCommands` | boolean | `true` | 在 command completion 中显示已安装的 skills |

Arrays 支持 glob patterns 和 exclusions。使用 `!pattern` exclude；使用 `+path` force-include exact path，使用 `-path` force-exclude exact path。

#### packages

String form 会加载 package 中的全部 resources：

```json
{
  "packages": ["myharness-skills", "@org/my-extension"]
}
```

Object form 用于筛选需要加载的 resources：

```json
{
  "packages": [
    {
      "source": "myharness-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

Package management 详情见 [packages.md](packages.md)。

## Example（示例）

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-opus-4-6",
  "defaultThinkingLevel": "medium",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": ["claude-*"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["myharness-skills"]
}
```

## Project Overrides（Project 覆盖）

Project settings（`.myharness/settings.json`）会覆盖 global settings。Nested objects 会进行 merge：

```json
// ~/.myharness/agent/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .myharness/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// 合并结果
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```
