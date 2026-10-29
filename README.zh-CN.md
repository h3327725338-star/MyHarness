# MyHarness

[English](README.md) | [简体中文](README.zh-CN.md)

[![License: Apache-2.0](https://img.shields.io/github/license/h3327725338-star/MyHarness)](LICENSE)

MyHarness 是装在你自己 Windows 电脑上的个人 AI，在你已经登录的网站里直接干活。它记得你在意的事，聊天和定时任务在你的几台电脑之间同步，写代码也照样能做。装好就能用 Nebius Token Factory 上的 DeepSeek V4.1 Flash 和 NVIDIA Nemotron 模型：粘贴一个 API Key，各项分工自动配好。

底层是一个 Electron 外壳，启动只监听本机（`127.0.0.1`）的 Web UI 和同一套后端，把模型 Provider 与你的文件、Shell 命令、内置浏览器、工具和可恢复 Session 连在一起。

> 当前状态：在 Windows x64 上可用，桌面端和源码 checkout 两条路径都维护。Nebius Token Factory 已经内置（设置 → Providers → **Nebius Token Factory**：粘贴 Key，DeepSeek V4.1 Flash 和 Nemotron 模型按分工自动配好）；其他兼容 OpenAI、Anthropic、Gemini 或 Mistral 的 Provider 可以手动添加。已经验证过的边界写在 [PROJECT_STATUS.md](PROJECT_STATUS.md)。

## 核心能力

- **代码协作**：Coding Agent 产品层提供文件、Shell、PowerShell、编辑、写入、Symbols、Git 和 GitHub 工作流。
- **入口**：本机浏览器 **Web UI**（`myharness`，只监听 loopback），并打包为 Windows 桌面应用；同时提供 Node.js SDK 供进程内集成。终端 TUI、Print 和 JSON 用户模式已移除，Web Terminal 面板保留。
- **对话与改动**：可恢复 Session、按轮次查看改动、分支摘要，以及长会话的 context compaction。
- **项目上下文**：project trust、`AGENTS.md` / `CLAUDE.md` context files、Workspace 与 Session 管理、Git 集成。
- **可扩展**：TypeScript extensions、skills、prompt templates、themes、custom Provider 和 MyHarness packages。
- **Code Intelligence**：通过可选的 Windows language-server 模块按语言提供 Symbols 语义导航。`symbols` 工具默认关闭，可用 `codeIntelligence.symbolsEnabled` 启用，修改后需重启生效。
- **双模式、同一后端**：Coding 模式在代码仓库里工作；General 模式处理查资料、写作和日常任务，带工作区指令、工作区记忆与资料库。聊天列表、草稿和配色按模式各自保存。
- **agent 能驱动的内置浏览器**：右侧面板是真实 Chromium 标签（桌面端为 `WebContentsView`，共用一个持久分区，重启后登录态还在）；`workspace` 工具可以导航、点击、打字、读页面或无障碍树、执行页面脚本、截图、下载文件、查看网络请求。
- **多智能体协作**：`agent`（前台与后台批次）、`workflow`（分阶段）、`ultracode`（多轮覆盖）三种派发，配三层活动条、可单独/全部停止和明确的结束状态；主 agent 可用 `agent_tasks` 列出并停止自己的派发。
- **逐角色绑模型**：主模型在输入框的模型菜单里选；设置 → 智能体里给每个辅助角色单独选 Provider、模型和思考档位——子智能体、Auto Memory、对话命名、压缩、分支摘要、交接摘要、提交描述、副本命名、翻译、视觉分析，以及备用模型。选“使用主模型”的角色跟随主对话的模型和思考档位；备用模型选它表示不启用备用。
- **网页搜索默认打开**：Tavily + Google。没填 Key 时 Tavily 走它的免费免 Key 通道（由 Tavily 限速）；设置 → 网页搜索里有 **获取免费 Key** 的链接，免费 Key 每月 1000 次。Bing、DuckDuckGo、Brave 可以另外加上，轻量请求被拦截的引擎会改用浏览器。
- **可选能力**：TypeScript extensions、skills 和 prompt templates。

源码和状态文档会把“已经实现的 contract”“已经加载的运行时配置”和“依赖机器或凭据的验证结果”分开记录。

## NVIDIA Nemotron on Nebius Token Factory

本项目参考的模型后端是 **[Nebius Token Factory](https://api.tokenfactory.nebius.com/v1/) 提供的 NVIDIA Nemotron**，而且已经内置：设置 → Providers 一打开就是 **Nebius Token Factory**。点 **获取 API Key** 会在内置浏览器里打开 Token Factory 控制台；粘贴到网页上方细栏（或设置里）的 Key 会先读取账户的模型列表确认可用，再作为普通的 `openai-completions` Provider 写入 `models.json`，所有还没有自己模型的工作都会配上对应的模型：

| 模型 | 负责 |
|------|------|
| DeepSeek V4.1 Flash 1017 | 主模型、提交说明（账户没有 DeepSeek 时由 Ultra 接手） |
| Nemotron 3 Ultra | 子智能体、对话命名、翻译 |
| Nemotron 3.5 Lightning | 压缩上下文、备用模型、自动记忆、交接摘要、书签用途、定时任务、工作副本命名、分支摘要 |
| Nemotron 3.5 Super VL | 视觉助手（识图） |

主对话用 DeepSeek V4.1 Flash，因为测试中 Nemotron 模型当主智能体时调用工具有问题；子智能体、命名、翻译、后台工作和识图交给 Nemotron 模型。主模型、子智能体和提交说明会设成所用模型最高的思考强度（DeepSeek 是 max，Ultra 是高）。每个 Nemotron 模型只提供 NVIDIA 为它写明的思考档位：Ultra 有关闭、中、高三档，Lightning 只有关闭和高；DeepSeek 有关闭、低、高和 max。

Token Factory 没有余额查询接口，所以 Nebius 卡片提供控制台链接（查看余额、充值），显示这台电脑按模型标价估算的花费；请求因余额问题被拒（HTTP 402 或错误信息提到余额）时会明确说明是余额问题。

![MyHarness 中一次完成的 Nemotron 3 Ultra 对话，右下角可见模型选择器](packages/coding-agent/docs/images/nebius-nemotron-session.png)

| Model ID | 上下文 | 最大输出 | 由谁添加 |
|----------|--------|----------|----------|
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 1,048,576 | 未公布（设为 65,536） | 内置配置和示例文件 |
| `nvidia/Nemotron-3-Ultra-550b-a55b` | 1,048,576 | 65,536 | 内置配置和示例文件 |
| `nvidia/Nemotron-3_5-Lightning` | 1,048,576 | 65,536 | 内置配置和示例文件 |
| `nvidia/Nemotron-3.5-Super-VL` | 1,048,576 | 未公布（设为 4,096） | 内置配置和示例文件 |
| `nvidia/nemotron-3-super-120b-a12b` | 262,144 | 65,536 | 只在示例文件里 |

内置配置按账户模型列表里的写法取用每个 ID。旧版本还会添加 Nemotron 3 Nano 负责命名和翻译，现在改由 Ultra 负责，已经添加过的 Nano 保持不动。DeepSeek V4.1 Flash 1017 和 Super-VL 能接图像；视觉助手开着时（默认开启），图片交给 Super-VL，主模型收到它的识图报告。Nemotron 的文本模型都是纯文本。2026-10-25 实测：一张含随机字符串、红色圆形和蓝色矩形的生成图片，约 1.3 秒被正确读出。给它留几千个输出 token——它先推理再回答。

![在模型选择器中挑选 Nebius 的 Nemotron 模型](packages/coding-agent/docs/images/nebius-model-picker.png)

不用界面的话，同一个 Provider 也可以用一个文件配好：

```powershell
# 1. 复制现成的 Provider 配置
Copy-Item packages\coding-agent\docs\examples\nebius-models.json "$env:USERPROFILE\.myharness\agent\models.json"

# 2. 通过环境变量提供 Token Factory key
$env:NEBIUS_TOKEN_FACTORY_API_KEY = "<your-token-factory-key>"

# 3. 启动后在 /model 里选择 “Nemotron 3 Ultra”
.\dev-desktop.cmd
```

也可以在设置 → **Providers** → **添加 Provider** 中手动创建：Base URL 填 `https://api.tokenfactory.nebius.com/v1/`，API type 选 OpenAI Chat Completions。示例里的纯文本模型声明 `text` 输入，只提供各自写明的 thinking 档位，通过 `reasoning_effort` 发送（Ultra：off / medium / high；Super：off / low / high；Lightning：off / high；`off` 发送为 `none`）；Super-VL 声明 `text` 和 `image` 输入，不发送 `reasoning_effort`，始终会推理。

- 完整配置、验证步骤和限制：[NVIDIA Nemotron on Nebius Token Factory](packages/coding-agent/docs/nebius-token-factory.md)。
- 可直接复制的配置：[`examples/nebius-models.json`](packages/coding-agent/docs/examples/nebius-models.json)。

## 记忆、用户画像与多端同步

- 常驻用户画像（`global/用户画像`）每一轮都发送，不参与“是否命中本轮问题”的排序；召回预算分层（画像位、目录位、动态卡片位），画像再大也挤不掉其它上下文。
- 三层记忆（全局、工作区、会话）加归档和待确认区，配套 search / read / write / delete / claim 工具。后台维护会把新材料压进画像、合并相近条目，不需要逐条确认。
- 直连 Google Drive API 同步：全部记忆层（含归档、待确认条目、画像）、General 模式的工作区与聊天（含分支和交接摘要）、会话附件与产物、资料库、草稿、General 模式的个性提示词、我的提示词，以及内置浏览器的书签、新标签页快捷方式和网站设置；浏览器的登录状态和已存密码只有设置了同步口令才会同步，上传前先在本机用口令加密。
- 不同步：API key、OAuth token、信任决定、工具权限、锁、运行中的任务、Coding 模式的聊天与仓库，以及其它 Web 偏好。
- 合并用的是稳定 key 加按设备的版本向量：记忆按与双方最后一致版本的差异做三方合并，聊天按 entry id 合并所以两条分支都保留，合不了的冲突保留本地版本、把对方存成可恢复副本并列在设置里。Drive 传来的数据不能授予项目信任、不能执行命令。
- 边界：这是对 Drive API 的真实实现，但自动化测试用的是内存传输，尚未在真实双机 Google 账号上跑通。退出应用后同步停止，除了浏览器加密的登录数据外没有端到端加密。详见 [Google Drive sync](packages/coding-agent/docs/google-drive-sync.md)。

## Quick Start（Windows）

**安装包。** 在 [Releases](https://github.com/h3327725338-star/MyHarness/releases) 页面的 MyHarness 版本里下载 `MyHarness-Setup-<版本号>.exe` 并运行。
- 安装包没有代码签名，SmartScreen 会先拦一下：点 **更多信息**，再点 **仍要运行**。
- 选 **仅为我安装** 就不需要管理员权限。
- 卸载后，`%USERPROFILE%\.myharness` 里的数据会保留。

**从源码运行。** 环境要求：

- Windows 10 或 11，x64；
- Node.js `>=22.19.0`；
- 如果要在 Windows 使用 `bash` tool，需要安装 Git for Windows；
- 一个模型 Provider 的 Key：Nebius Token Factory 已内置，其他 Provider 可以手动添加。

```powershell
git clone https://github.com/h3327725338-star/MyHarness.git
cd MyHarness
npm.cmd install --ignore-scripts
npm.cmd run build
.\dev-desktop.cmd
```

`dev-desktop.cmd` 会构建并启动 Electron 桌面端，这是日常使用 MyHarness 的方式。需要在命令行直接跑源码时，在仓库根目录执行 `node --import ./scripts/dev-fast-loader.mjs ./packages/coding-agent/src/web.ts`；它不会打开浏览器，会在日志中打印实际地址 `MyHarness Web UI: <url>`。

启动后，开始页面会链接到内置的 Nebius Token Factory 配置（设置 → Providers）。在那里粘贴 Token Factory 的 Key，DeepSeek V4.1 Flash 和 Nemotron 模型就配好了。其他 Provider 的说明见 [Providers](packages/coding-agent/docs/providers.md) 和 [Settings](packages/coding-agent/docs/settings.md)。

没有 Provider 凭据时，可以先检查 Web 源码入口是否能够启动：

```powershell
node --import ./scripts/dev-fast-loader.mjs ./packages/coding-agent/src/web.ts --help
```

这个 smoke check 不能证明外部 Provider、OAuth flow、Web Search service 或真实 model conversation 已经成功。

## 评估本项目

[Judge testing guide](docs/JUDGE_TESTING.md) 写了“安装或从源码构建”、如何挂上 Nebius Token Factory 凭据、五分钟测试脚本、源码该看哪里，以及已知限制。

## 文档

- [Coding Agent 文档索引](packages/coding-agent/docs/index.md)
- [Coding Agent 中文文档索引](packages/coding-agent/docs/index.zh-CN.md)
- [Quickstart](packages/coding-agent/docs/quickstart.md)
- [使用说明与 Web 启动](packages/coding-agent/docs/usage.md)
- [Provider 与 model](packages/coding-agent/docs/providers.md)
- [NVIDIA Nemotron on Nebius Token Factory](packages/coding-agent/docs/nebius-token-factory.md)
- [Google Drive sync](packages/coding-agent/docs/google-drive-sync.md)
- [Windows 设置](packages/coding-agent/docs/windows.md)
- [当前项目状态与验证边界](PROJECT_STATUS.md)
- [架构与开发维护手册](ARCHITECTURE_AND_DEVELOPMENT.md)
- [开发指南](packages/coding-agent/docs/development.md)
- [源码模块地图](packages/coding-agent/docs/source-modules.md)
- [存储与数据边界](docs/STORAGE.md)
- [维护手册](MAINTENANCE.md)
- [GitHub 自动化](docs/maintenance/github-automation.md)
- [贡献指南](CONTRIBUTING.zh-CN.md)
- [安全策略](SECURITY.md)
- [完整文档总索引](DOCUMENTATION_INDEX.md)
- [English README](README.md)

## 开发与贡献

在仓库根目录执行常用检查：

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run audit:release
```

`npm.cmd run check` 会以可写模式运行 Biome，可能改写格式化文件。检查范围、发布/隐私边界和 Pull Request 要求见[贡献指南](CONTRIBUTING.zh-CN.md)。

## 致谢

MyHarness 最初 fork 自 Mario Zechner 的 [pi-mono](https://github.com/badlogic/pi-mono)（MIT 协议），之后经过大量重写和扩展。原项目许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## License

MyHarness 自有代码使用 [Apache License 2.0](LICENSE)。继承代码和第三方组件继续保留各自的 license、copyright 和 attribution，详见 [NOTICE](NOTICE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
