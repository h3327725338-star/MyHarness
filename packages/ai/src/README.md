# packages/ai/src — AI / Provider 源码目录

本文件按目录说明 `@myharness/ai` 的源码。包级说明见 [docs/index.md](../docs/index.md)，包级维护规则见 [docs/maintenance.md](../docs/maintenance.md)。

## 说明

### 顶层文件

| 文件 | 内容 |
| --- | --- |
| `types.ts` | 核心类型：`Api`、`Model`、消息与内容块、`Usage`、流事件、`StreamOptions`、Thinking 档位、Provider 响应元数据 |
| `models.ts` | `Models` / `createModels()` / `createProvider()`：Provider 注册、认证解析、模型查询与刷新、流式请求分发；费用计算、Thinking 档位裁剪 |
| `models-store.ts` | 动态模型列表的存储接口与内存实现 |
| `images-models.ts`、`images.ts`、`images-api-registry.ts`、`image-models.ts` | 图片生成模型的对应入口 |
| `session-resources.ts` | 按会话登记并统一清理的资源 |
| `index.ts` | 包根出口 |
| `compat.ts` | 旧的全局 API 兼容入口（`getModel`、`stream`、`complete`、API 注册表等），对应 `./compat` 子路径 |
| `legacy-api-aliases.ts`、`env-api-keys.ts` | 兼容入口用到的旧别名与环境变量 Key 查找 |
| `oauth.ts`、`bun-oauth.ts`、`bedrock-provider.ts` | 对应 `./oauth`、`./bun-oauth`、`./bedrock-provider` 子路径的入口 |
| `models.generated.ts`、`image-models.generated.ts` | 生成文件；当前内容为空目录 |
| `cli.ts` | 包自带的 OAuth 登录命令行；只列出 `builtinProviders()` 中带 OAuth 的 Provider，而该列表当前为空 |

### api/ — 各协议的请求实现

每种协议一个实现文件，加一个按需加载的 `.lazy.ts` 包装：

- `anthropic-messages.ts`、`openai-completions.ts`、`openai-responses.ts`（及 `openai-responses-shared.ts`）、`azure-openai-responses.ts`、`google-generative-ai.ts`、`google-vertex.ts`（及 `google-shared.ts`、`google-http-options.ts`）、`mistral-conversations.ts`、`bedrock-converse-stream.ts`、`myharness-messages.ts`（MyHarness 自己的消息协议）。

共用部分：`transform-messages.ts`（跨协议消息转换）、`simple-options.ts`（简化选项到各协议参数）、`lazy.ts`、`openai-prompt-cache.ts`、`github-copilot-headers.ts`、`cloudflare.ts`。

`system-prompt-loader.ts`：定位并读取仓库根 `system-prompts/` 下的提示文件（`loadSystemPrompt()`）。

### auth/ — 认证契约

| 文件 | 内容 |
| --- | --- |
| `types.ts` | 凭证、`CredentialStore`、API Key 与 OAuth 两种认证方式、认证交互事件 |
| `resolve.ts` | `resolveProviderAuth()` 与 `ModelsError` |
| `helpers.ts` | `envApiKeyAuth()`、`lazyOAuth()` |
| `context.ts`、`credential-store.ts` | 默认认证上下文、内存凭证存储 |
| `oauth/` | 通用 OAuth 工具：设备码轮询、PKCE、回调页面、flow 加载入口（本仓库不打包上游 Provider 的 OAuth flow） |

### compat/

`extension-oauth-types.ts`：给扩展声明 OAuth 用的类型。

### providers/

| 文件 | 内容 |
| --- | --- |
| `all.ts` | 内置 Provider 的兼容入口。当前返回空集合：MyHarness 不打包上游 Provider 和模型目录 |
| `faux.ts` | 测试用的假 Provider |

### utils/

事件流（`event-stream.ts`）、用量估算（`estimate.ts`）、上下文溢出识别（`overflow.ts`）、可重试错误识别（`retry.ts`）、错误体规范化（`error-body.ts`）、JSON 修复解析、工具参数校验（`validation.ts`）、请求头、代理、Unicode 清理、UUID、TypeBox 辅助等。

### 依赖方向

```text
index.ts / compat.ts → models.ts、api/*、auth/*、providers/*、utils/*
api/* → types.ts、models.ts、utils/*
auth/* → types.ts
utils/* → types.ts
```

对外依赖各 Provider 的官方 SDK。本包不依赖仓库里的其他包。

## 维护

- `api/` 里有某个协议的实现，不代表有对应的 Provider 可用；Provider 必须由调用方用 `createProvider()` 注册。
- `providers/all.ts` 和两个 `*.generated.ts` 当前是空的兼容入口，不要把它们当作默认 Provider 列表，也不要在这里加产品层的 Provider 注册。
- 新增协议：在 `api/` 加实现和 `.lazy.ts`，在 `types.ts` 的 `Api` 与选项映射里登记，从 `index.ts`（必要时 `compat.ts`）导出，并在 `package.json` 的 `exports` 中确认子路径。
- 子路径（`./compat`、`./api/*`、`./auth/*`、`./oauth` 等）是公共 API，移动文件前先看 `package.json`。
- 错误信息、日志和测试快照里不能出现凭证或完整请求头。
- 测试：`packages/ai/test/`。真实网络请求、OAuth 和模型刷新不能由静态测试证明。
