# Web Search

MyHarness 自带联网搜索和网页读取，不需要部署 SearXNG、Crawl4AI 或任何其他服务。默认关闭；打开后 Agent 会获得 `web_search` 和 `web_fetch` 两个工具。

## 设置

在交互模式打开 `/settings` → **Web Search**：

| 选项 | 含义 | 范围 | 默认 |
| --- | --- | --- | --- |
| **Web Search** | 总开关。关闭时两个工具不会出现在 Agent 的工具列表和系统提示中；已有 Session 和工具结果不会被删除 | On / Off | Off |
| **Search Engines** | 允许使用哪些搜索引擎，可以同时开多个 | 见下表 | DuckDuckGo、Brave |
| **Pages to Read per Search** | 每次 `web_search` 搜完后，自动按排名读取前几个结果的网页正文；0 = 只返回结果列表 | 0–10 | 3 |
| **Max URLs per Fetch** | 一次 `web_fetch` 最多读取几个网址；超出的网址不读取，并在结果里列出来告诉 Agent | 1–20 | 10 |
| **Concurrent Downloads** | 同一时间最多下载几个网页。这是整个进程的共享上限：Agent 并行调用多个联网工具时也不会超过它 | 1–8 | 4 |

三个数字只能在设置页的列表里选择，列表里就是全部合法值；工具内部用的是同一组上限，不会出现“设置允许但运行时悄悄截断”的情况。手动编辑 `settings.json` 写入超出范围的数字时，会按最近的上下限处理。

### 搜索引擎

| 引擎 | 接入方式 | 需要配置 | 稳定性 |
| --- | --- | --- | --- |
| DuckDuckGo | 请求 `lite.duckduckgo.com` 的纯 HTML 结果页并解析 | 无 | 免费，但短时间内请求较多时会返回人机验证（HTTP 202） |
| Brave | 请求 `search.brave.com` 的结果页并解析 | 无 | 免费，但请求较多时会返回 HTTP 429 限流 |
| Brave Search API | 官方 API `api.search.brave.com/res/v1/web/search` | API Key | 最稳定；需要在 Brave 申请 Key，按 Brave 的套餐计费/限额 |

DuckDuckGo 和 Brave 属于网页抓取方式：它们不是公开 API，页面结构或反爬策略改变时可能失效，也可能因为网络环境（IP、地区）被要求验证。遇到人机验证或 429 时，MyHarness 会在 2 分钟内暂停使用该引擎，避免继续请求；其他已启用的引擎照常工作，失败原因会出现在工具结果的 Diagnostics 中。需要稳定结果时建议开启 Brave Search API。

Google、Bing、百度目前没有内置：Google 结果页需要执行 JavaScript，Bing 对程序请求返回空结果，百度对程序请求返回验证码页面，都无法在不绕过验证的前提下稳定使用。

**Brave Search API Key** 在 Search Engines 页面里填写。输入时会被遮挡，保存在 agent 目录下的 `web-search-keys.json`（仅当前用户可读写，带文件锁），不会写进 `settings.json`。留空回车会删除已保存的 Key。没有保存 Key 时会读取环境变量 `BRAVE_SEARCH_API_KEY`。

Search Engines 页面的 **Test Selected Engines** 会用每个已启用的引擎真实搜索一次，分别显示是否可用、结果数和耗时；等待时按 Esc 会取消请求并返回。

`settings.json` 示例：

```json
{
  "webSearch": {
    "enabled": true,
    "engines": ["duckduckgo", "brave", "brave_api"],
    "pagesPerSearch": 3,
    "maxUrlsPerFetch": 10,
    "fetchConcurrency": 4
  }
}
```

### 旧配置迁移

基于 SearXNG/Crawl4AI 的旧字段不再使用，读取时按下面方式处理，下一次在设置页修改 Web Search 时从文件中删除：

- `enabled` 保留；
- `parallelPages` 为手动数值时，迁移为 `maxUrlsPerFetch`（超出 1–20 时取最近的上下限）；
- 旧 `engines` 中与内置引擎同名的（`duckduckgo`、`brave`）保留；一个都不匹配时使用默认引擎；
- `searxngUrl`、`crawl4aiUrl`、`engineMode`、`scope`、`allowedDomains`、`searchRounds`、`searchCacheTtlMs`、`fetchCacheTtlMs` 被忽略。旧的 Website Scope allowlist 不再生效；需要限定网站时可以在搜索词中使用 `site:example.com`。

环境变量 `MYHARNESS_CRAWL4AI_API_TOKEN` 不再使用。

## Agent 工具

| Tool | 参数 | 返回 |
| --- | --- | --- |
| `web_search` | `queries`（1–5 个独立问题）、可选 `timeRange`（`day`/`month`/`year`）、`maxResults`（1–20，默认 10）、`readPages`（0–10，默认且最多为 Pages to Read per Search）、`fresh` | 合并去重后的结果（标题、URL、来源引擎、摘要、发布日期）；以及前几个结果网页里与问题最相关的片段 |
| `web_fetch` | `urls`（1–20 个，实际最多读取 Max URLs per Fetch 个）、`fresh` | 每个 URL 的 Markdown 正文或独立的失败原因 |

搜索规划由 Agent 负责：它决定搜什么、搜几次、读哪些网页、证据够不够。原来把查询改写、多轮搜索和“证据是否充分”判断固定在工具里的 `web_research` 已删除；旧 Session 里的 `web_research` 调用和结果记录不会被删除或改写，和其他已停用工具的历史记录一样保留在 Session 中。

数据流：

```text
Agent 调用 web_search
  → 每个 query × 每个已启用引擎并行请求（最多 4 个同时进行）
  → 按规范化 URL 合并去重、过滤不安全 URL、排序（多个引擎都返回的结果排名更高）
  → 取前 N 个结果（N = Pages to Read per Search）
  → 通过共享下载上限读取网页正文 → Markdown → 挑出与问题最相关的片段
  → 返回结果列表 + 片段；完整正文进入 Tool Result 持久化文件
```

每个 query 至少保留一个最佳结果，避免一个 query 的结果挤掉其他 query。长网页会按问题给所有段落打分，不只取开头。

## 网页读取

`web_fetch` 和 `web_search` 的读网页部分使用同一个读取器，与搜索引擎无关：

- 只允许 `http`/`https`；拒绝带用户名密码的 URL、`localhost`、本机地址和私有/保留 IP；
- 域名先做 DNS 解析，解析到本机或私有地址时拒绝（防止借公网域名访问内网）；
- 跳转不自动跟随，每一跳都重新做以上检查，最多 5 次；
- 单个网页请求 20 秒超时，最多下载 5 MB，Markdown 最多保留 300,000 字符，超出时在结果里注明；
- 按 `Content-Type` 或 `<meta charset>` 解码（支持 GBK 等中文编码）；HTML 会去掉脚本、样式、导航、侧栏、表单和页眉页脚，优先取 `<main>`/`<article>`，保留标题、代码、表格、列表和链接；纯文本、JSON、XML 原样返回；PDF 等其他类型返回“不支持”的明确错误；
- 不执行 JavaScript，也不管理登录、Cookie、表单或验证码。依赖前端渲染或需要登录的页面只能读到公开 HTML 中已有的部分。

一个 URL 失败不会影响同一批其他 URL。工具可见结果是有长度上限的预览，完整 Markdown 通过现有 Tool Result persistence 保存到 Session 目录，Agent 可以按返回的路径读取。

## 缓存、错误和取消

- 搜索结果缓存 5 分钟，网页缓存 15 分钟，作用域是当前 Session：持久化 Session 保存在 Session 目录的 `web-cache/`，非持久化运行只用内存（最多 256 条）。`fresh: true` 或包含“最新/今天/现在/latest/today”等词的搜索会跳过缓存。失败结果不缓存。
- 错误类型会分开报告：`captcha`、`rate_limited`、`missing_api_key`、`timeout`、`unavailable`（附带 `ECONNREFUSED` 等底层原因）、`http`、`blocked`、`too_many_redirects`、`unsupported_content`、`empty_content`、`limit` 等。部分引擎或网页失败时，成功的部分照常返回，失败写在 Diagnostics 里；所有引擎都失败时工具调用本身报错，并列出每个引擎的原因。
- 取消（Esc/abort）会中止所有正在进行和排队中的请求，工具调用以“已取消”结束，Session 可以继续使用。

## 真实联网测试

普通测试不访问公网。需要验证真实链路时运行：

```powershell
npm.cmd run test:web-search:e2e
```

它会真实读取公开网页（包括一次跳转和一次被拒绝的本机地址），并用 DuckDuckGo 和 Brave 真实搜索。可用 `MYHARNESS_WEB_SEARCH_E2E_ENGINES=brave_api` 等方式指定引擎（`brave_api` 需要 `BRAVE_SEARCH_API_KEY`）。搜索部分失败通常说明当前网络环境被引擎要求验证或限流，不代表网页读取有问题。

参考：[Brave Search API](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started)。
