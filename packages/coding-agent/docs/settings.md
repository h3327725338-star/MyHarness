# Settings（设置）

MyHarness 使用 JSON settings files，project settings 会覆盖 global settings。

| 位置 | Scope |
|----------|-------|
| `~/.myharness/agent/settings.json` | Global（所有 projects） |
| `.myharness/settings.json` | Project（当前目录） |

可以直接编辑文件，也可以使用 `/settings` 修改常用选项。

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

Non-interactive modes（`-p` 和 `--mode json`）不会显示 trust prompt。如果没有适用的已保存 trust decision，它们使用 global settings 中的 `defaultProjectTrust`：`ask`（默认）和 `never` 会忽略 project resources，`always` 表示信任。使用 `--approve`/`-a` 或 `--no-approve`/`-na` 可以对单次运行覆盖 Project Trust。

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
| `subAgent` | object | `{ "enabled": false }` | Global built-in exploration-agent 和 workflow configuration。通过 `/settings` 设置。 |
| `webSearch` | object | `{ "enabled": false }` | Global built-in web search configuration（搜索引擎和三个数量）；只在启用时向 main Agent 注册 `web_search` 和 `web_fetch`。详见 [Web Search](web-search.md)。 |
| `visionAssistant` | object | `{ "enabled": false }` | Global dedicated image-analysis model configuration。通过 `/settings` 设置。 |
| `visionCapabilityTests` | object | - | custom models 的 image-capability probe results cache，适用于未声明 input support 的 models。可选；尚未执行 probe 时不存在。 |
| `gitIntegration` | object | `{ "enabled": false }` | 仅当前 project 使用的 local Git version history integration。通过 `/settings` 设置。 |

Auto Memory、Sub Agent、Vision Assistant 和 Compact Model 选模型的规则相同（`src/agent/runtime/assistant-model.ts`）：

- 没有设置 `provider` / `model`（Web UI 里的“使用主模型”）：运行时使用当前 main model，并且连同它当前的 Thinking Effort 一起继承；main model 变了就跟着变。如果另外写了 `thinkingLevel`，只覆盖 Effort。
- 设置了自己的 `provider` + `model`：使用这个 model 和它自己的 `thinkingLevel`；没写 `thinkingLevel`（Web UI 里的“默认”）时不发送 Effort，相当于 `off`（例如 Gemini 会明确关闭 thinking）。
- 只写了 `provider` 或 `model` 其中一个，视为没有配置。

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
3. Task 的 post-processing 完成后，发起一次 tool-free structured model request，处理最终的 conversation delta，并在发布 main AI 的 final text 前等待结果。该 request 会提取持久的 user preferences、corrections、已验证的 project facts 和有用的 references；
4. 至少存在五个不同 sessions，且距离上次 consolidation 已经过 24 小时后，请选中的 model 合并重复或过长的 memories。

选中的 model 用于 extraction 和 consolidation，不用于同步 recall step。Extraction 会收到有边界的 conversation delta 和 memory manifest，但没有 project tools，因此不能独立检查或修改项目。启用该功能会将 conversation content 发送给选中的 model，并将 final-text publication 延迟到 request 完成，可能产生 model usage。如果 extraction 失败，MyHarness 会报告 warning 并释放 final response，不会无限期阻塞。Automatic memory 只适用于 persisted sessions；`--no-session` runs 不会读写 long-term memory。

Memory Markdown files 是 source of truth：

- Global preferences 和 feedback：`~/.myharness/agent/memory/global/*.md`；
- Project-specific memory：`~/.myharness/agent/memory/projects/<project-hash>/*.md`；
- Derived index 和 extraction state：`~/.myharness/agent/memory/index.json` 与 `state.json`。

关闭该 setting 会停止 extraction 和 recall，但不会删除已有 memory files。写入前，MyHarness 会拒绝 private keys，并 redacts 常见的 API-key、token、password、secret 和 Bearer credential patterns。这是 defensive filter，不能保证检测出所有可能的 secret formats。

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

`Sub Agent` 是 global 设置。启用后，在 `/settings` 中 MyHarness 会要求选择一个可用 model，以及该 model 支持的 thinking level。之后 main AI 可以使用：

- `agent` 将一次 investigation 拆分为最多 18 个并行 Explore tasks。
- 每个 delegated Explore task 默认没有总时间上限（`totalRuntimeLimitMs` 以毫秒为单位；`0` 表示无上限，`taskTimeoutMs` 是兼容旧配置的别名）。默认 Stall Timeout 为 10 分钟：它只在没有有效新进展时计时，检测到新的工具范围或结果会重置计时器。
- `maxTurns` 默认 `0`（无限制）；达到正数上限会保留 `partial` 结果。`stallTimeoutMs` 为 `0` 时关闭 stall watchdog；`noProgressDetection` 和 `repeatedOperationDetection` 默认开启。
- `workflow` 运行一个或多个 sequential phases，每个 phase 可以包含多个并行 Explore tasks。第一个 phase 之后的每个 phase 都会收到上一阶段的 results。

`/workflow` 和 `/ultracode` prompt commands 分别指示 main AI 使用 `workflow` 和 `ultracode` tools。`/ultracode` 使用更严格的中文 instructions；如果第一次 Ultracode run 不够，会继续执行后续 run。所有 phase 和 task descriptions 都由 main AI 决定；child agents 不能再创建更多 agents。

Child agents 可以使用 read、grep、find、ls 和 Bash，但不能使用 edit 或 write。它们使用基于 blacklist 的 Bash guard，因此这个 setting 面向 inspection，而不是严格的 read-only security boundary。

```json
{
  "subAgent": {
    "enabled": true,
    "provider": "anthropic",
    "model": "claude-opus-4-6",
    "thinkingLevel": "high",
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

搜索和网页读取都由 MyHarness 内置完成，不需要部署或填写任何外部服务地址。用户可以选择搜索引擎、Firefox 兜底和三个数量：

| 字段 | 含义 | 范围 | 默认 |
| --- | --- | --- | --- |
| `engines` | 启用的搜索引擎：`google`、`bing`、`duckduckgo`、`brave`、`brave_api`（需要 API Key） | 任意组合 | `["google", "bing"]` |
| `browserFallback` | 轻量请求被拦截时，是否允许使用 MyHarness 专用 Firefox 配置打开真实搜索页 | On / Off | `true` |
| `pagesPerSearch` | 每次搜索后自动读取前几个结果的网页正文；0 = 只返回结果 | 0–10 | 3 |
| `maxUrlsPerFetch` | 一次 `web_fetch` 最多读取几个网址 | 1–20 | 10 |
| `fetchConcurrency` | 同时下载网页的最大数量（所有联网工具共享） | 1–8 | 4 |

```json
{
  "webSearch": {
    "enabled": true,
    "engines": ["google", "bing"],
    "browserFallback": true,
    "pagesPerSearch": 3,
    "maxUrlsPerFetch": 10,
    "fetchConcurrency": 4
  }
}
```

`browserFallback` 使用 MyHarness 专用 Firefox profile，与用户自己的 Firefox 隔离，并复用该 profile 中的 Cookie/Session。Firefox 未安装、扩展无法连接或 profile 被占用时会在 Diagnostics 中说明原因；如果页面仍要求 CAPTCHA/consent，交互界面会提示用户在弹出的 Firefox 页面完成验证，无人值守模式返回 `challenge_required`。

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
| `theme` | string | - | Theme 名称（`"dark"`、`"light"` 或 custom）。未设置时，interactive TUI 默认使用 `"dark"`，但 SettingsManager 本身返回 `undefined`。 |
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
| `showHardwareCursor` | boolean | `false`（或 `MYHARNESS_HARDWARE_CURSOR=1`） | TUI 为支持 IME 定位时显示 terminal cursor |

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
| `webShutdownGraceSeconds` | number | `10` | Web UI（`--web`）在最后一个浏览器页面断开后等待多少秒再退出；期间刷新或重新打开页面会取消退出。Web UI 设置里的最小值是 3。仅适用于 global setting，下一次倒计时开始时生效。见 [Web UI](web-ui.md)。 |

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
| `retry.maxRetries` | number | `3` | agent-level retry 的最大 attempts |
| `retry.baseDelayMs` | number | `2000` | agent-level exponential backoff 的 base delay（2s、4s、8s） |
| `retry.provider.timeoutMs` | number | `300000`（由 `httpIdleTimeoutMs` 提供） | Provider/SDK request timeout，单位为 milliseconds；显式设置后覆盖全局 HTTP idle timeout |
| `retry.provider.maxRetries` | number | `0` | Provider/SDK 额外 retry 次数；未设置时 MyHarness 对支持该选项的内置 adapter 只发起一次请求 |
| `retry.provider.maxRetryDelayMs` | number | `60000` | 失败前允许的最大 server-requested delay（60s） |

当 Provider 请求的 retry delay 超过 `retry.provider.maxRetryDelayMs`（例如 Google 返回 `"quota will reset after 5h"`）时，request 会立即失败并给出说明性 error，不会静默等待。设置为 `0` 可以关闭此 cap。

除非明确需要 provider-level retries，否则建议将 `retry.provider.maxRetries` 保持为 `0`。设置为大于 `0` 的值后，SDK/provider retries 可能会在 MyHarness 感知到之前处理 out-of-usage-limit errors；某些情况下这会让 agent 一直阻塞到 Provider quota reset。

Google Generative AI 和 Vertex adapter 会把 `timeoutMs` 与 `maxRetries` 显式传给 Google SDK，并覆盖 SDK 默认的隐式 retry；`maxRetries` 表示额外重试次数，不是总请求次数。Agent-level retry（`retry.maxRetries`）是另一层独立机制。

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

### Message Delivery

| Setting | Type | Default | 说明 |
|---------|------|---------|-------------|
| `steeringMode` | `"all"\|"one-at-a-time"` | `"one-at-a-time"` | Steering messages 的发送方式 |
| `followUpMode` | `"all"\|"one-at-a-time"` | `"one-at-a-time"` | Follow-up messages 的发送方式 |
| `transport` | string | `"auto"` | 支持多种 transports 的 Providers 使用的 preferred transport：`"sse"`、`"websocket"`、`"websocket-cached"` 或 `"auto"` |
| `httpIdleTimeoutMs` | number | `300000` | HTTP header/body idle timeout，单位为 milliseconds；也用于有显式 stream idle timeout 的 Providers。设置为 `0` 可关闭 |
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
