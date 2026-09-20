# Providers（Provider 和模型）

当前 MyHarness 不提供默认 Provider/model catalog：`packages/ai/src/providers/all.ts` 的 built-in catalog 为空。Provider API implementations 位于 `packages/ai/src/api/` 及相关兼容入口，但实际可用的 Provider/Model 由 `models.json`、`ModelRuntime`、模型缓存和 Extension registration 共同决定。单独设置 environment variable 不会创建 Provider 或 model。已配置的 Provider 可以刷新 catalog，并将它们缓存到 `~/.myharness/agent/models-store.json`，供 offline 使用。

## 目录

- [Provider catalog 与注册](#provider-catalog)
- [API Keys](#api-keys)
- [Auth File（认证文件）](#auth-file)
- [Legacy Provider 配置参考](#legacy-provider-configuration-reference)
- [llama.cpp](#llamacpp)
- [自定义 Providers](#custom-providers)
- [解析顺序](#resolution-order)

<a id="provider-catalog"></a>
## Provider catalog 与注册

当前源码可以确认默认 built-in Provider catalog 为空。需要区分 Provider API implementation、model 配置和运行时注册结果；后两者可能来自 `models.json` 或 Extension。具体 Provider 是否可用需要结合当前配置和运行时状态确认。

<a id="api-keys"></a>
## API Keys

### Environment Variables 或 Auth File

在 interactive mode 中，打开 `/settings` → **Providers**，选择一个已配置或注册的 Provider，然后管理它的 **API Keys**。Enabled Providers 和 saved-but-disabled Providers 会分组显示。一个 Provider 可以保存多个带名称的 keys，但该 Provider 下的所有 models 只使用手动选中的 current key；MyHarness 不会自动 rotate 或 fail over。Values 会以 plain text 保存在 `~/.myharness/agent/auth.json` 中，因此不要分享这个 file。legacy `vision-auth.json` 中已有的 entries 会被导入，但旧 file 不会删除。

可以通过 environment variable 设置 credentials。下面的 mapping 只会在对应的 configured、custom 或 extension Provider 已存在时生效；它本身不会创建 Provider。

```bash
export ANTHROPIC_API_KEY=sk-ant-...
myharness
```

| Provider | Environment Variable | `auth.json` key |
|----------|----------------------|------------------|
| Anthropic | `ANTHROPIC_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` | `anthropic` |
| Ant Ling | `ANT_LING_API_KEY` | `ant-ling` |
| Azure OpenAI Responses | `AZURE_OPENAI_API_KEY` | `azure-openai-responses` |
| OpenAI | `OPENAI_API_KEY` | `openai` |
| NVIDIA NIM | `NVIDIA_API_KEY` | `nvidia` |
| Google Gemini | `GEMINI_API_KEY` | `google` |
| Google Vertex AI | `GOOGLE_CLOUD_API_KEY` | `google-vertex` |
| Amazon Bedrock | `AWS_BEARER_TOKEN_BEDROCK` | `amazon-bedrock` |
| Mistral | `MISTRAL_API_KEY` | `mistral` |
| Groq | `GROQ_API_KEY` | `groq` |
| Cerebras | `CEREBRAS_API_KEY` | `cerebras` |
| Cloudflare AI Gateway | `CLOUDFLARE_API_KEY` (+ `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID`) | `cloudflare-ai-gateway` |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY` (+ `CLOUDFLARE_ACCOUNT_ID`) | `cloudflare-workers-ai` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` | `github-copilot` |
| xAI | `XAI_API_KEY` | `xai` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `vercel-ai-gateway` |
| ZAI Coding Plan (Global) | `ZAI_API_KEY` | `zai` |
| ZAI Coding Plan (China) | `ZAI_CODING_CN_API_KEY` | `zai-coding-cn` |
| OpenCode Zen | `OPENCODE_API_KEY` | `opencode` |
| OpenCode Go | `OPENCODE_API_KEY` | `opencode-go` |
| Radius | `RADIUS_API_KEY` | `radius` |
| Hugging Face | `HF_TOKEN` | `huggingface` |
| Fireworks | `FIREWORKS_API_KEY` | `fireworks` |
| Together AI | `TOGETHER_API_KEY` | `together` |
| Kimi For Coding | `KIMI_API_KEY` | `kimi-coding` |
| MiniMax | `MINIMAX_API_KEY` | `minimax` |
| MiniMax (China) | `MINIMAX_CN_API_KEY` | `minimax-cn` |
| Moonshot AI | `MOONSHOT_API_KEY` | `moonshotai` |
| Moonshot AI (China) | `MOONSHOT_API_KEY` | `moonshotai-cn` |
| Qwen Token Plan | `QWEN_TOKEN_PLAN_API_KEY` | `qwen-token-plan` |
| Qwen Token Plan (China) | `QWEN_TOKEN_PLAN_CN_API_KEY` | `qwen-token-plan-cn` |
| Xiaomi MiMo | `XIAOMI_API_KEY` | `xiaomi` |
| Xiaomi MiMo Token Plan (China) | `XIAOMI_TOKEN_PLAN_CN_API_KEY` | `xiaomi-token-plan-cn` |
| Xiaomi MiMo Token Plan (Amsterdam) | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` | `xiaomi-token-plan-ams` |
| Xiaomi MiMo Token Plan (Singapore) | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | `xiaomi-token-plan-sgp` |

Environment-variable mappings 定义在 [`packages/ai/src/env-api-keys.ts`](../../ai/src/env-api-keys.ts) 中，并使用 [`packages/ai/src/auth/helpers.ts`](../../ai/src/auth/helpers.ts) 里的 authentication helpers。

对于 Anthropic，同时设置 `ANTHROPIC_OAUTH_TOKEN` 和 `ANTHROPIC_API_KEY` 时，前者优先。

当前 interactive UI 只有 DeepSeek 提供了经过验证的 account-balance adapter。它使用 `<provider-base-url>/user/balance`，每 5 秒 refresh 一次。该 adapter 可以独立跟踪 main model 和 Vision Assistant。DeepSeek 会通过 Provider ID 或 official API hostname 识别，因此 custom DeepSeek configuration 不必使用固定的 catalog ID。Balance lookup failures 不会中断 model requests；Vision Assistant 没有可用 balance 时，其 footer 会显示 `余额未知`。

<a id="auth-file"></a>
#### Auth File

将 credentials 保存到 `~/.myharness/agent/auth.json`：

```json
{
  "anthropic": { "type": "api_key", "key": "sk-ant-..." },
  "ant-ling": { "type": "api_key", "key": "..." },
  "openai": { "type": "api_key", "key": "sk-..." },
  "nvidia": { "type": "api_key", "key": "nvapi-..." },
  "google": { "type": "api_key", "key": "..." },
  "opencode": { "type": "api_key", "key": "..." },
  "opencode-go": { "type": "api_key", "key": "..." },
  "together": { "type": "api_key", "key": "..." },
  "moonshotai": { "type": "api_key", "key": "..." },
  "moonshotai-cn": { "type": "api_key", "key": "..." },
  "qwen-token-plan":  { "type": "api_key", "key": "sk-sp-..." },
  "qwen-token-plan-cn": { "type": "api_key", "key": "sk-sp-..." },
  "xiaomi": { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-cn":  { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-ams": { "type": "api_key", "key": "..." },
  "xiaomi-token-plan-sgp": { "type": "api_key", "key": "..." }
}
```

该 file 会以 `0600` permissions 创建（仅 user 可读写）。Auth file credentials 的优先级高于 environment variables。

API key credentials 还可以包含 provider-scoped environment values。在解析 credential key、provider/model headers，以及 Cloudflare account IDs、Azure OpenAI settings、Vertex project/location、Bedrock settings、`MYHARNESS_CACHE_RETENTION` 和 `HTTP_PROXY`/`HTTPS_PROXY` 等 Provider configuration 时，这些 values 会优先于 process environment variables。

```json
{
  "cloudflare-ai-gateway": {
    "type": "api_key",
    "key": "$CLOUDFLARE_API_KEY",
    "env": {
      "CLOUDFLARE_API_KEY": "...",
      "CLOUDFLARE_ACCOUNT_ID": "account-id",
      "CLOUDFLARE_GATEWAY_ID": "gateway-id"
    }
  }
}
```

当 MyHarness 需要使用与 project shell environment 不同的 provider settings 时，可以使用这种配置。

### Key Resolution（Key 解析）

`key` field 支持 command execution、environment interpolation 和 literal values：

- **Shell command：**开头为 `"!command"` 时，会将整个 value 作为 command 执行并使用 stdout（在 process lifetime 内缓存）
  ```json
  { "type": "api_key", "key": "!security find-generic-password -ws 'anthropic'" }
  { "type": "api_key", "key": "!op read 'op://vault/item/credential'" }
  ```
- **Environment interpolation：**`"$ENV_VAR"` 或 `"${ENV_VAR}"` 使用指定 variable 的值。Interpolation 也可以出现在更长的 literal 中。
  ```json
  { "type": "api_key", "key": "$MY_ANTHROPIC_KEY" }
  { "type": "api_key", "key": "${KEY_PREFIX}_${KEY_SUFFIX}" }
  ```
  `$FOO_BAR` 表示 variable `FOO_BAR`；当 `BAR` 是 literal text 时，使用 `${FOO}_BAR`。缺少 environment variable 时，该 value 会保持 unresolved。
- **Escapes：**`"$$"` 输出 literal `"$"`；`"$!"` 输出 literal `"!"`，且不会触发 command execution。
  ```json
  { "type": "api_key", "key": "$$literal-dollar-prefix" }
  { "type": "api_key", "key": "$!literal-bang-prefix" }
  ```
- **Literal value：**直接使用。像 `MY_API_KEY` 这样的普通 uppercase strings 会被当作 literals；需要引用 environment variable 时使用 `$MY_API_KEY`。
  ```json
  { "type": "api_key", "key": "sk-ant-..." }
  { "type": "api_key", "key": "public" }
  ```

Extensions 也可以在这个 file 中保存 OAuth credentials。

<a id="legacy-provider-configuration-reference"></a>
## Legacy Provider Configuration Reference（Legacy Provider 配置参考）

下面这些 provider-specific configuration notes 不代表 fresh installation 已经注册了这些 Provider。它们作为 models.json、extensions 或 native Provider 的兼容配置参考保留；如果没有先添加对应的 Provider 和 model configuration，不要期待这些 commands 能直接工作。

### Azure OpenAI 配置

```bash
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_BASE_URL=https://your-resource.ai.azure.com
# 也支持：https://your-resource.cognitiveservices.azure.com
# 也支持：https://your-resource.openai.azure.com
# root endpoints 会自动规范化为 /openai/v1
# 也可以用 resource name 代替 base URL
export AZURE_OPENAI_RESOURCE_NAME=your-resource

# 可选
export AZURE_OPENAI_API_VERSION=2024-02-01
export AZURE_OPENAI_DEPLOYMENT_NAME_MAP=gpt-4=my-gpt4,gpt-4o=my-gpt4o
```

### Amazon Bedrock 配置

可以将 Bedrock API key 保存到 `auth.json`，也可以配置以下任一 ambient AWS credential source：

```bash
# 方式 1：AWS Profile
export AWS_PROFILE=your-profile

# 方式 2：IAM Keys
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...

# 方式 3：Bearer Token
export AWS_BEARER_TOKEN_BEDROCK=...

# 可选 region（默认是 us-east-1）
export AWS_REGION=us-west-2
```

还支持 ECS task roles（`AWS_CONTAINER_CREDENTIALS_*`）和 IRSA（`AWS_WEB_IDENTITY_TOKEN_FILE`）。

```bash
myharness --provider amazon-bedrock --model us.anthropic.claude-sonnet-4-20250514-v1:0
```

对于 ID 中包含可识别 model name 的 Claude models（base models 和 system-defined inference profiles），会自动启用 prompt caching。对于 application inference profiles（其 ARNs 不包含 model name），设置 `AWS_BEDROCK_FORCE_CACHE=1` 来启用 cache points：

```bash
export AWS_BEDROCK_FORCE_CACHE=1
myharness --provider amazon-bedrock --model arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123
```

如果连接的是 Bedrock API proxy，可以使用以下 environment variables：

```bash
# 设置 Bedrock proxy 的 URL（standard AWS SDK env var）
export AWS_ENDPOINT_URL_BEDROCK_RUNTIME=https://my.corp.proxy/bedrock

# 如果 proxy 不需要 authentication，则设置
export AWS_BEDROCK_SKIP_AUTH=1

# 如果 proxy 只支持 HTTP/1.1，则设置
export AWS_BEDROCK_FORCE_HTTP1=1
```

### Cloudflare AI Gateway 配置

`CLOUDFLARE_API_KEY` 可以作为 environment variable 设置。account ID 和 gateway slug 可以作为 environment variables 设置，也可以写入 `auth.json` 中 API key credential 的 `env` object。

```bash
export CLOUDFLARE_API_KEY=...
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_GATEWAY_ID=...        # 在 dash.cloudflare.com → AI → AI Gateway 中创建
myharness --provider cloudflare-ai-gateway --model "claude-sonnet-4-5"
```

通过 Cloudflare AI Gateway 路由到 OpenAI、Anthropic 和 Workers AI。Workers AI 使用 Unified API（`/compat`）和带 prefix 的 model IDs（`workers-ai/@cf/...`）。OpenAI 使用 OpenAI passthrough route（`/openai`），配合原生 OpenAI model IDs，例如 `gpt-5.1`。Anthropic 使用 Anthropic passthrough route（`/anthropic`），配合原生 Anthropic model IDs，例如 `claude-sonnet-4-5`。

AI Gateway authentication 使用 `CLOUDFLARE_API_KEY` 作为 `cf-aig-authorization`。Upstream authentication 可以采用以下模式之一：

| 模式 | Request auth | Upstream auth |
|------|--------------|---------------|
| Workers AI | Cloudflare token only | Cloudflare-native |
| Unified billing | Cloudflare token only | Cloudflare 处理 upstream auth 并扣除 credits |
| Stored BYOK | Cloudflare token only | Cloudflare 注入保存在 AI Gateway dashboard 中的 provider keys |
| Inline BYOK | Cloudflare token plus upstream `Authorization` header | Request 自己提供 upstream provider key |

对于正常的 MyHarness 使用，建议选择 unified billing 或 stored BYOK。Inline BYOK 需要为 Cloudflare AI Gateway Provider 配置额外的 upstream `Authorization` header，例如通过 `models.json` 中的 provider/model override。

### Cloudflare Workers AI 配置

`CLOUDFLARE_API_KEY` 可以作为 environment variable 设置。`CLOUDFLARE_ACCOUNT_ID` 可以作为 environment variable 设置，也可以写入 `auth.json` 中 API key credential 的 `env` object。

```bash
export CLOUDFLARE_API_KEY=...
export CLOUDFLARE_ACCOUNT_ID=...
myharness --provider cloudflare-workers-ai --model "@cf/moonshotai/kimi-k2.6"
```

MyHarness 会自动设置 `x-session-affinity`，以获得 [prefix caching](https://developers.cloudflare.com/workers-ai/features/prompt-caching/) discounts。

### Google Vertex AI 配置

支持显式的 Google Cloud API key、Application Default Credentials（ADC）或 service-account credentials file。Interactive model login flow 可以将所选 authentication method 及其 project/location values 保存到 `auth.json`。

API-key authentication：

```bash
export GOOGLE_CLOUD_API_KEY=...
```

ADC：

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=your-project
export GOOGLE_CLOUD_LOCATION=us-central1
```

使用 service account 时，将 `GOOGLE_APPLICATION_CREDENTIALS` 设置为 credentials file 的路径。ADC 和 service-account authentication 都需要 `GOOGLE_CLOUD_PROJECT`（或 `GCLOUD_PROJECT`）以及 `GOOGLE_CLOUD_LOCATION`。

## llama.cpp

MyHarness 支持 llama.cpp router server。通过 `models.json` 配置，并使用 `/model` 选择已加载的 model。

Server 配置、model directory layout、environment variables 和 command usage 详见 [llama.cpp](llama-cpp.md)。

<a id="custom-providers"></a>
## Custom Providers（自定义 Providers）

**通过 `/settings` 或 models.json：**打开 **Providers** → **添加 Provider** → **创建自定义 Provider**，按向导添加 Ollama、LM Studio、vLLM，或任何支持所列 API（OpenAI Completions、OpenAI Responses、Anthropic Messages、Google Generative AI）的 Provider；也可以直接编辑 `models.json`。保存后，custom Providers 会出现在 enabled/disabled lists 中。详见 [models.md](models.md)。

**通过 extensions：**需要 custom API implementations 或 OAuth flows 的 providers，应创建 extension。详见 [custom-provider.md](custom-provider.md) 和 [examples/extensions/custom-provider-gitlab-duo](../examples/extensions/custom-provider-gitlab-duo/)。

<a id="resolution-order"></a>
## Resolution Order（解析顺序）

解析 Provider credentials 时，优先级如下：

1. CLI 的 `--api-key` flag
2. `auth.json` entry（API key 或 OAuth token）
3. `models.json` 中的 custom provider keys
4. Environment variable（环境变量）
