# Web Search

MyHarness 的 Web Search 是一个可选的 Agent 工具层：SearXNG 负责发现来源，Crawl4AI 负责读取公开网页并生成 Markdown。默认关闭，也不会假设任何本机端口或远程服务地址。

## 启用与配置

在交互模式打开 `/settings` → **Web Search**，然后设置：

- **Web Search**：关闭时，`web_research`、`web_search` 和 `web_fetch` 不会出现在当前 Agent 的工具注册表或系统提示中；关闭不会删除历史 Session。
- **SearXNG URL**：SearXNG 基础 URL。实例需要允许 JSON 搜索格式。
- **Crawl4AI URL**：Crawl4AI Docker/API 基础 URL。
- **Search Engines**：从配置的 SearXNG `/config` 动态读取。`Auto` 不发送 `engines` 参数，由 SearXNG 按实例配置选择引擎；`Selected` 只发送当前动态发现且被用户保存的引擎。不会使用 MyHarness 内置的固定引擎清单。
- **Website Scope**：`Unrestricted`，或 `Only selected websites`。allowlist 按真实 hostname 匹配，允许根域名及其子域名，不接受字符串包含式绕过。
- **Allowed Websites**：逗号分隔的 hostname，例如 `openai.com, docs.python.org`。搜索结果和直接提供给 `web_fetch` 的 URL 都会经过同一范围检查。
- **Parallel Pages**：`Agent decides` 使用有限的内置安全上限；`Manual` 接受任意正整数，控制单次最多读取的 URL 数量。
- **Search Rounds**：`Agent decides` 使用有限的内置安全上限；`Manual` 接受任意正整数。一次 Round 是“搜索 → 读取网页”的完整调查阶段，不是 Tool Call 次数。

也可以直接写入 global settings：

```json
{
  "webSearch": {
    "enabled": true,
    "searxngUrl": "https://search.example",
    "crawl4aiUrl": "http://127.0.0.1:11235",
    "engineMode": "selected",
    "engines": ["brave", "duckduckgo"],
    "scope": "allowlist",
    "allowedDomains": ["example.com"],
    "parallelPages": { "mode": "manual", "value": 10 },
    "searchRounds": { "mode": "agent" }
  }
}
```

如果 Crawl4AI 服务启用了 JWT/API token，可将 token 放在运行 MyHarness 的进程环境变量 `MYHARNESS_CRAWL4AI_API_TOKEN` 中。该值不会写入 Settings，也不会出现在 Tool 参数或诊断文本里。

## Agent 工具

Agent 只接触 MyHarness 自己的三个 Web 工具：

| Tool | 用途 | 返回内容 |
| --- | --- | --- |
| `web_research` | 接受一个现实世界问题，可选 freshness、hostname 限定、来源数和最大 Research Rounds | 自动规划互补 Query，按 Query coverage、engine/domain diversity、relevance、freshness 和 source quality 融合排序，读取来源并返回 Evidence Pack |
| `web_search` | 接受一个或多个 query，可选引擎、`day`/`month`/`year` 时间范围、结果数量和 freshness 标志 | 去重、过滤、透明 heuristic 排序后的 title、URL、snippet、source；不直接返回网页全文 |
| `web_fetch` | 接受一个或多个明确的 HTTP(S) URL，可选 freshness 标志 | 每个 URL 独立成功/失败状态；成功内容为保留标题、代码、表格、列表、引用和链接文字的 Markdown |

`web_research` 的每个 Evidence Chunk 都保留 source ID、标题、URL、hostname、heading、excerpt、发布日期（若可靠获得）和 source type。长页面会先完整保存，再按问题/Query 对所有正文段落打分，不只取页面开头；完整 Evidence Pack 通过既有 Tool Result persistence 保存，模型收到有界预览和路径引用。

一次 Research Round 表示完整的 `Query → Search → Source Selection → Fetch → Evidence Evaluation` 周期。Evidence 不足时会在硬上限内 reformulate；所有来源失败会返回 `failed` 状态和明确 diagnostics，不伪装成成功。

不知道来源时先 Search；已经知道 URL，或用户直接给出 URL 时直接 Fetch，不要求先执行 Search。多个 Query 和多个 URL 都会在受控并发下执行。一个 URL 失败不会掩盖同一批次的其他成功结果。

网页正文的可见结果是短预览；完整 Markdown 通过现有 Tool Result persistence 通道保存，让 Agent 可以沿用当前 Session 的大结果处理和生命周期，而不是把所有正文直接塞进 Context。每个页面仍保留自己的来源 URL。

## 缓存、错误和安全

- Search 和 Fetch 使用当前 Session 作用域的缓存；持久化 Session 的缓存位于该 Session 目录下，非持久化运行只使用内存缓存。TTL 有设置字段，`fresh: true` 或明显的“最新/今天/现在”等查询会绕过对应缓存。
- SearXNG、Crawl4AI 未配置、不可用、HTTP 错误、无效 JSON、超时、取消和 URL 阻止会使用独立诊断，不会被伪装成“没有结果”。
- Research diagnostics 会区分 `search_timeout`、`search_unavailable`、`fetch_timeout`、`crawl_failed`、`empty_content`、`extraction_failed`、`all_sources_failed` 和 `aborted` 等阶段；部分 Query、engine 或 URL 失败不会掩盖同一轮的成功结果。
- URL 只允许 `http`/`https`，拒绝凭据、localhost、本机地址和常见私有/保留 IP；allowlist 使用 hostname 边界匹配。Crawl4AI 返回的重定向 URL 还会重新校验。
- MyHarness 不管理网页登录、Cookie、账号 Session、表单、CAPTCHA、点击操作或 Computer Use。页面需要登录时，Tool 会失败或只能读取公开部分。

## 服务协议

MyHarness 使用 SearXNG 的 `/config` 和 `/search?format=json`，并使用 `time_range`、动态引擎选择及 JSON result 字段。Crawl4AI 使用非流式 `POST /crawl`，读取其 `CrawlResult` 中的 Markdown；不会使用流式端点或另起一套 Agent Loop。服务的具体版本、认证和绑定地址由部署方负责。

## Health Check 与真实 E2E

设置中的 **Health** 仍只检查 SearXNG `/config` 和 Crawl4AI `/health`。**Run Web Search Test** 会额外执行固定 Query `SearXNG official documentation`，选择一个安全公开 URL，完成 Search → Fetch → Extraction → Evidence Chunk，并分别显示阶段状态、耗时、失败阶段和 diagnostics。

普通离线测试不依赖公网。配置真实服务后可以显式执行：

```powershell
$env:MYHARNESS_WEB_SEARCH_SEARXNG_URL = "http://127.0.0.1:8080"
$env:MYHARNESS_WEB_SEARCH_CRAWL4AI_URL = "http://127.0.0.1:11235"
npm.cmd run test:web-search:e2e
```

该命令失败时只能说明当前配置的真实服务链路未通过；mock 单测不会替代真实联网验证。

参考：[SearXNG Search API](https://docs.searxng.org/dev/search_api.html)、[SearXNG engine settings](https://docs.searxng.org/admin/settings/settings_engines.html)、[Crawl4AI Docker API](https://github.com/unclecode/crawl4ai/blob/main/deploy/docker/README.md)、[Crawl4AI CrawlResult](https://docs.crawl4ai.com/core/crawler-result/)。
