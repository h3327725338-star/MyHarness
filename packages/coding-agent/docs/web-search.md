# Web Search

MyHarness 自带联网搜索和网页读取，不需要部署 SearXNG、Crawl4AI、Docker 或任何其他服务。默认关闭；打开后 Agent 会获得 `web_search` 和 `web_fetch` 两个工具。

Google 和 Bing 不需要 API Key：MyHarness 先用轻量的普通 HTTP 请求搜索；只有当搜索引擎明确拦截了这种请求（验证码、限流、403、需要 JavaScript、降级结果）时，才用本机已安装的 Firefox 打开真实的搜索页读取结果。Firefox 是可选的：没装 Firefox 时 MyHarness 照常启动，轻量请求照常工作，只是被拦截时没有兜底，工具结果会写明原因。

## 设置

在交互模式打开 `/settings` → **Web Search**：

| 选项 | 含义 | 范围 | 默认 |
| --- | --- | --- | --- |
| **Web Search** | 总开关。关闭时两个工具不会出现在 Agent 的工具列表和系统提示中；已有 Session 和工具结果不会被删除 | On / Off | Off |
| **Search Engines** | 允许使用哪些搜索引擎，可以同时开多个 | 见下表 | Google、Bing |
| **Firefox Fallback** | 轻量请求被拦截时，是否允许用本机 Firefox 打开真实搜索页。这一行同时显示是否找到了 Firefox | On / Off | On |
| **Pages to Read per Search** | 每次 `web_search` 搜完后，自动按排名读取前几个结果的网页正文；0 = 只返回结果列表 | 0–10 | 3 |
| **Max URLs per Fetch** | 一次 `web_fetch` 最多读取几个网址；超出的网址不读取，并在结果里列出来告诉 Agent | 1–20 | 10 |
| **Concurrent Downloads** | 同一时间最多下载几个网页。这是整个进程的共享上限：Agent 并行调用多个联网工具时也不会超过它 | 1–8 | 4 |

三个数字只能在设置页的列表里选择，列表里就是全部合法值；工具内部用的是同一组上限。手动编辑 `settings.json` 写入超出范围的数字时，会按最近的上下限处理。

### 搜索引擎

| 引擎 | 轻量方式（先用） | Firefox 方式（被拦截时） | 需要配置 |
| --- | --- | --- | --- |
| Google | `www.google.com/wml/search`：Google 给功能手机提供的纯 XHTML 结果页，不需要 JavaScript。用 IPv4 连接（很多 IPv6 网段一律被要求验证），带 `sca_esv` 参数（缺少时返回 403） | `www.google.com/search?udm=14`（只看网页结果）。结果链接是 `/goto?url=…` 形式，MyHarness 用一次不跟随跳转的请求读出真实网址 | 无 |
| Bing | `www.bing.com/search` 普通页面 | 同一个页面在 Firefox 中打开 | 无 |
| DuckDuckGo | `lite.duckduckgo.com/lite` | `html.duckduckgo.com/html` | 无 |
| Brave | `search.brave.com/search` | 同一个页面在 Firefox 中打开 | 无 |
| Brave Search API | 官方 API `api.search.brave.com/res/v1/web/search` | 没有（API 与网页搜索相互独立，也不作为 Google/Bing 的兜底） | API Key |

除 Brave Search API 外都不是公开 API，页面结构或反自动化策略改变时可能需要更新解析器；解析失败会明确报告为 `invalid_response`，不会被当成"被拦截"去启动浏览器掩盖掉。

实测行为（2026-09，马来西亚住宅网络，Windows 11，Firefox 156）：

- Google 轻量方式大多数请求成功，偶尔某一次请求返回 sorry 验证页（按请求随机出现）；MyHarness 会换一个 UA 重试一次，仍被拦时这一次查询改用 Firefox。
- Bing 轻量方式经常返回 HTTP 200 但结果与问题无关（例如搜 `rust tokio select` 返回游戏《Rust》）。MyHarness 检查结果里是否完全没有出现问题中的某个词，出现这种情况就把它当作被拦截，改用 Firefox；Firefox 中的 Bing 结果正常。
- 本网络下 DuckDuckGo 轻量方式基本总是返回人机验证（HTTP 202），Firefox 方式可用；Brave 在请求较多时返回 429。

**Brave Search API Key** 在 Search Engines 页面里填写。输入时会被遮挡，保存在 agent 目录下的 `web-search-keys.json`（仅当前用户可读写，带文件锁），不会写进 `settings.json`。留空回车会删除已保存的 Key。没有保存 Key 时会读取环境变量 `BRAVE_SEARCH_API_KEY`。

Search Engines 页面的 **Test Selected Engines** 会用每个已启用的引擎真实搜索一次，显示是否可用、结果数、走的是轻量请求还是 Firefox、耗时；等待时按 Esc 会取消请求并返回。在这个页面测试时如果搜索引擎在 Firefox 中也要求人机验证，会打开 Firefox 窗口让你完成。

`settings.json` 示例：

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

### 旧配置迁移

- 上一版本的默认引擎列表 `["duckduckgo", "brave"]`，如果是由没有 `browserFallback` 字段的旧版本保存的，视为"从未改过的默认值"，迁移为新的默认 `["google", "bing"]`。其他旧列表（例如只选了 `brave`）是用户自己的选择，保持不变；以新格式保存过的 `["duckduckgo", "brave"]` 也保持不变。
- 没有 `browserFallback` 字段时按 On 处理。
- 基于 SearXNG/Crawl4AI 的旧字段不再使用，读取时按下面方式处理，下一次在设置页修改 Web Search 时从文件中删除：`enabled` 保留；`parallelPages` 为手动数值时迁移为 `maxUrlsPerFetch`；旧 `engines` 中与内置引擎同名的（现在包括 `google`、`bing`）保留，一个都不匹配时使用默认引擎；`searxngUrl`、`crawl4aiUrl`、`engineMode`、`scope`、`allowedDomains`、`searchRounds`、`searchCacheTtlMs`、`fetchCacheTtlMs` 被忽略。需要限定网站时可以在搜索词中使用 `site:example.com`。

## 结构

```text
web_search / web_fetch（tool.ts，Agent 只看到这两个工具）
  → WebSearchService（service.ts）：多 query × 多引擎并发、合并去重、排序、缓存、读网页
      → EngineRunner（engine-runner.ts）：先轻量，按错误类型决定是否用 Firefox、冷却
          → Search Engine（engines/*.ts）：拼请求、判断页面是不是被拦截、解析结果
              → Transport（transport.ts）
                  ├─ HttpTransport：普通 HTTP（undici，走 HTTP(S)_PROXY），可指定 IPv4
                  └─ BrowserTransport：FirefoxBrowser（browser/*.ts）
      → readPage（page.ts）：web_fetch 和搜索后读网页，与搜索引擎无关
```

搜索引擎只负责"搜什么、结果在哪、这是不是拦截页"；怎么把请求发出去由 Transport 负责。两种 Transport 都返回同样的 `TransportPage`（状态码、最终网址、HTML），同一个引擎的解析器不关心页面来自 HTTP 还是 Firefox。

### 什么时候用 Firefox

只有下面这些"访问被拦截"类错误会让一次查询改用 Firefox：

| 错误码 | 含义 |
| --- | --- |
| `captcha` | 验证码 / Google sorry 页 / DuckDuckGo 202 |
| `rate_limited` | HTTP 429 |
| `forbidden` | HTTP 403 |
| `js_required` | 返回了必须执行 JavaScript 的页面 |
| `consent` | Cookie 同意页 |
| `degraded` | 返回 200 但结果与问题无关（Bing） |

下面这些错误不会启动浏览器，会直接出现在工具结果里：解析器认不出页面（`invalid_response`）、普通 HTTP 错误（`http`，如 500）、网络连不上（`unavailable`）、超时、代码异常（报告为 `internal`，并注明"这是软件问题"）等。

调度规则：

- 每次查询都先试轻量请求；一次被拦截只让这一次查询改用 Firefox。同一引擎连续 2 次被拦截后，3 分钟内跳过轻量请求直接用 Firefox，之后再试轻量请求。
- 同一引擎的 Firefox 访问之间至少间隔 1.5 秒，最多同时开 3 个标签页。
- 某个引擎在所有可用方式上都被拒绝后，2 分钟内暂停使用这个引擎，工具结果会写明暂停原因（原始错误）。
- Google 轻量请求在同一次查询里最多发 2 次（换 UA 重试 1 次）；没有无限重试。
- Firefox 结果被视为真实用户会看到的结果，不再做 Bing 的"降级"判断。

### Firefox 兜底如何工作

- **使用真实 Firefox，不用 WebDriver。** MyHarness 用 MyHarness 自己的 Firefox 配置文件（`<agent 目录>/web-search/firefox/profile`，不碰你自己的 Firefox 配置）启动 Firefox，通过 Firefox 自带的远程调试协议把一个小扩展作为"临时附加组件"装进去（和 `web-ext run` 相同的方式；正式版 Firefox 只允许这样加载未签名扩展）。页面里没有 `navigator.webdriver`，也不用 Marionette/Playwright/Selenium。
- **扩展和 MyHarness 的通信**：扩展的后台脚本长轮询 `http://127.0.0.1:<随机端口>/<随机令牌>/poll` 取命令，把结果 POST 回来。只监听本机回环地址，令牌每次启动重新生成。命令只有：打开网页并等结果出现、读取当前页面、关闭标签页。
- **结果**：扩展等到结果区域出现（每个引擎有自己的选择器），把最终页面的 HTML、最终网址和 HTTP 状态交回，由引擎的解析器解析。Agent 不直接操作浏览器。
- **会话复用**：Cookie、同意选择和通过的验证都保存在这个专用配置文件里，MyHarness 重启后继续使用。不同网站的 Cookie 由 Firefox 按网站分开保存。
- **平时无界面**：普通兜底用无界面（headless）Firefox，首次启动约 1–2 秒，之后每次读取约 0.5–1 秒。空闲 3 分钟后自动关闭；MyHarness 退出时一并关闭。
- **需要人工验证时**：如果在 Firefox 里也遇到验证码或同意页，并且当前是交互界面（TUI），MyHarness 会打开一个可见的 Firefox 窗口，工具进度里提示你去完成验证；最长等待 3 分钟，Esc 取消。验证通过后搜索自动继续，之后的搜索复用这次验证，窗口关闭，后续恢复无界面。在 print/json/rpc 等无人值守模式下不会弹窗，工具结果返回 `challenge_required` 并说明需要在交互界面里完成一次。
- **可靠性**：Firefox 未安装、被关闭、崩溃、扩展没连上、页面加载失败或超时，都会以明确的错误返回（`browser_unavailable` / `unavailable` / `timeout`），下一次需要时重新启动 Firefox。上次 MyHarness 异常退出留下的 Firefox（按专用配置文件路径确认，不会误关你自己的 Firefox）会在下次启动前关闭。同一时间只有一个 MyHarness 进程能使用这个配置文件，另一个进程会得到明确提示。

找 Firefox 的顺序：环境变量 `MYHARNESS_FIREFOX_PATH` → `Program Files`/`Program Files (x86)`/`%LOCALAPPDATA%` 下的 `Mozilla Firefox\firefox.exe` → `PATH`。

安全说明：Firefox 运行期间，远程调试端口监听在 `127.0.0.1` 的随机端口上（安装扩展要用）。本机其他程序理论上可以连上它控制这个专用配置文件里的浏览器；它不含你的个人 Firefox 数据，并且会在空闲时随 Firefox 一起关闭。不想接受这一点时，把 Firefox Fallback 关掉即可。

## Agent 工具

| Tool | 参数 | 返回 |
| --- | --- | --- |
| `web_search` | `queries`（1–5 个独立问题）、可选 `timeRange`（`day`/`month`/`year`）、`maxResults`（1–20，默认 10）、`readPages`（0–10，默认且最多为 Pages to Read per Search）、`fresh` | `Engines:` 行写明每个引擎实际走的方式（如 `Google (HTTP), Bing (Firefox)`）；合并去重后的结果（标题、URL、来源引擎、摘要、发布日期）；以及前几个结果网页里与问题最相关的片段。`details.routes` 里有每个引擎 × 问题的方式和改用 Firefox 的原因 |
| `web_fetch` | `urls`（1–20 个，实际最多读取 Max URLs per Fetch 个）、`fresh` | 每个 URL 的 Markdown 正文或独立的失败原因 |

搜索规划由 Agent 负责：它决定搜什么、搜几次、读哪些网页、证据够不够。

数据流：

```text
Agent 调用 web_search
  → 每个 query × 每个已启用引擎并行（最多 4 个同时进行）
      → 轻量请求 →（被拦截时）Firefox →（需要人工时，仅交互界面）可见窗口
  → 按规范化 URL 合并去重、过滤不安全 URL、排序（多个引擎都返回的结果排名更高）
  → 取前 N 个结果（N = Pages to Read per Search）
  → 通过共享下载上限读取网页正文 → Markdown → 挑出与问题最相关的片段
  → 返回结果列表 + 片段；完整正文进入 Tool Result 持久化文件
```

## 网页读取

`web_fetch` 和 `web_search` 的读网页部分使用同一个读取器，与搜索引擎、Firefox 都无关：

- 只允许 `http`/`https`；拒绝带用户名密码的 URL、`localhost`、本机地址和私有/保留 IP；
- 域名先做 DNS 解析，解析到本机或私有地址时拒绝（防止借公网域名访问内网）；
- 跳转不自动跟随，每一跳都重新做以上检查，最多 5 次；
- 单个网页请求 20 秒超时，最多下载 5 MB，Markdown 最多保留 300,000 字符，超出时在结果里注明；
- 支持 gzip/br/deflate；按 `Content-Type` 或 `<meta charset>` 解码（支持 GBK 等中文编码）；HTML 会去掉脚本、样式、导航、侧栏、表单和页眉页脚，优先取 `<main>`/`<article>`，保留标题、代码、表格、列表和链接；纯文本、JSON、XML 原样返回；PDF 等其他类型返回"不支持"的明确错误；
- 不执行 JavaScript，也不管理登录、Cookie、表单或验证码。

一个 URL 失败不会影响同一批其他 URL。工具可见结果是有长度上限的预览，完整 Markdown 通过现有 Tool Result persistence 保存到 Session 目录，Agent 可以按返回的路径读取。

## 缓存、错误和取消

- 搜索结果缓存 5 分钟，网页缓存 15 分钟，作用域是当前 Session：持久化 Session 保存在 Session 目录的 `web-cache/`，非持久化运行只用内存（最多 256 条）。`fresh: true` 或包含"最新/今天/现在/latest/today"等词的搜索会跳过缓存。失败结果不缓存。
- 部分引擎或网页失败时，成功的部分照常返回，失败写在 Diagnostics 里（带错误码）；所有引擎都失败时工具调用本身报错，并列出每个引擎的原因（同时尝试了轻量请求和 Firefox 时两者的原因都会写出）。
- 取消（Esc/abort）会中止所有正在进行和排队中的请求（包括 Firefox 中的读取和等待人工验证），工具调用以"已取消"结束，Session 可以继续使用。

## 真实联网测试

普通测试不访问公网，也不启动 Firefox。需要验证真实链路时运行：

```powershell
npm.cmd run test:web-search:e2e
```

它会：

- 用一个本地网页服务器测试真实 Firefox 通道（加载、脚本跳转、429、打不开的页面、取消、可见窗口中的验证流程、Cookie 跨重启保留、配置文件独占、Firefox 崩溃后恢复）；
- 真实读取公开网页（包括一次跳转和一次被拒绝的本机地址）；
- 对 Google 和 Bing 分别用 `OpenAI GPT`、`Taylor's University`、`马来西亚 人工智能` 真实搜索，检查结果标题、网址、摘要和相关性；各连续搜索 12 次；
- 强制走 Firefox 通道，用真实 Firefox 读取真实的 Google/Bing 结果页；
- 在 Agent 工具循环里真实调用 `web_search` 和 `web_fetch`。

每次搜索会输出一行 `[e2e]` 日志，写明每个引擎实际走的是 HTTP 还是 Firefox。可用 `MYHARNESS_WEB_SEARCH_E2E_ENGINES=google,bing,duckduckgo` 等方式指定引擎（`brave_api` 需要 `BRAVE_SEARCH_API_KEY`）。

参考：[Brave Search API](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started)。

## 已知限制

- 真实 Google/Bing CAPTCHA 的人工完成流程受外部网络和搜索引擎策略影响，仓库中的人工验证集成测试主要使用本地 challenge 页面模拟；不能把模拟通过理解成所有线上 CAPTCHA 都能稳定复现或完成。
- Bing 的降级结果识别是基于查询词和结果文本的启发式判断；搜索引擎 HTML DOM 或反自动化策略变化时，解析器和判断规则仍需维护。
- Firefox Transport 依赖 localhost Remote Debugging / IPC、已安装的 Firefox 和专用 profile；Firefox 未安装、扩展接入失败、profile 被其他 MyHarness 进程占用或浏览器崩溃时会返回明确失败，不会把错误伪装成搜索结果。
- 高频搜索仍可能触发搜索引擎 CAPTCHA 或限流；Google 轻量路径固定使用 IPv4，因为当前 IPv6 网络表现不可靠。
