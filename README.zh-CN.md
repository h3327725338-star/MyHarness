# MyHarness

[English](README.md) | [简体中文](README.zh-CN.md)

[![License: Apache-2.0](https://img.shields.io/github/license/h3327725338-star/MyHarness)](LICENSE)

MyHarness 是一个 Windows 桌面 AI 编程工作区。Electron 外壳启动只监听本机（`127.0.0.1`）的 Web UI 和同一套后端，把已配置的 model Provider 与项目文件、Shell 命令、工具和可恢复 Session 连接到同一个工作流里。

> 当前状态：在 Windows x64 上可用，桌面端和源码 checkout 两条路径都维护。MyHarness 不内置 Provider catalog，使用真实模型会话前需要配置 Provider、model 和凭据。已经验证过的边界写在 [PROJECT_STATUS.md](PROJECT_STATUS.md)。

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
- **逐角色绑模型**：设置 → 智能体里给每个角色单独选 Provider、模型和思考档位——主模型、子智能体、Auto Memory、对话命名、压缩、分支摘要、交接摘要、提交描述、副本命名、翻译、视觉分析，以及备用模型。留空的角色继承主模型。
- **可选能力**：Web Search（优先 Google/Bing，可选 Tavily API 与浏览器兜底）、TypeScript extensions、skills 和 prompt templates。

源码和状态文档会把“已经实现的 contract”“已经加载的运行时配置”和“依赖机器或凭据的验证结果”分开记录。

## NVIDIA Nemotron on Nebius Token Factory

本项目参考的模型后端是 **[Nebius Token Factory](https://api.tokenfactory.nebius.com/v1/) 提供的 NVIDIA Nemotron 3**。MyHarness 走的是通用 custom Provider 路径：运行时调用 Token Factory 的 Chat Completions API，仓库里没有厂商专属代码。

![MyHarness 中一次完成的 Nemotron 3 Ultra 对话，右下角可见模型选择器](packages/coding-agent/docs/images/nebius-nemotron-session.png)

| Model ID | 上下文 | 最大输出 | 用途 |
|----------|--------|----------|------|
| `nvidia/Nemotron-3-Ultra-550b-a55b` | 1,048,576 | 65,536 | 默认：长上下文推理与编辑 |
| `nvidia/nemotron-3-super-120b-a12b` | 262,144 | 65,536 | 成本更低的日常轮次 |
| `nvidia/Nemotron-3_5-Lightning` | 1,048,576 | 65,536 | 快速小步和工具循环 |
| `nvidia/Nemotron-3.5-Super-VL` | 1,048,576 | 未公布 | 图像、文档页和截图 |

只有 Super-VL 能接图像，其余三个是纯文本。2026-10-25 实测：一张含随机字符串、红色圆形和蓝色矩形的生成图片，约 1.3 秒被正确读出。给它留几千个输出 token——它先推理再回答。

![在模型选择器中挑选 Nebius 的 Nemotron 模型](packages/coding-agent/docs/images/nebius-model-picker.png)

配置只需要一个文件或一个设置页：

```powershell
# 1. 复制现成的 Provider 配置
Copy-Item packages\coding-agent\docs\examples\nebius-models.json "$env:USERPROFILE\.myharness\agent\models.json"

# 2. 通过环境变量提供 Token Factory key
$env:NEBIUS_TOKEN_FACTORY_API_KEY = "<your-token-factory-key>"

# 3. 启动后在 /model 里选择 “Nemotron 3 Ultra”
.\dev-desktop.cmd
```

也可以在 `/settings` → **Providers** → **创建自定义 Provider** 中创建：Base URL 填 `https://api.tokenfactory.nebius.com/v1/`，API type 选 OpenAI Chat Completions。三个模型都声明 `text` 输入，并把 MyHarness 的 thinking 档位映射到 `reasoning_effort`（`off` → `none`，其余同名）。

- 完整配置、验证步骤和限制：[NVIDIA Nemotron on Nebius Token Factory](packages/coding-agent/docs/nebius-token-factory.md)。
- 可直接复制的配置：[`examples/nebius-models.json`](packages/coding-agent/docs/examples/nebius-models.json)。

## 记忆、用户画像与多端同步

- 常驻用户画像（`global/用户画像`）每一轮都发送，不参与“是否命中本轮问题”的排序；召回预算分层（画像位、目录位、动态卡片位），画像再大也挤不掉其它上下文。
- 三层记忆（全局、工作区、会话）加归档和待确认区，配套 search / read / write / delete / claim 工具。后台维护会把新材料压进画像、合并相近条目，不需要逐条确认。
- 直连 Google Drive API 同步：全部记忆层（含归档、待确认条目、画像）、General 模式的工作区与聊天（含分支和交接摘要）、会话附件与产物、资料库、草稿和各模式个性提示词。
- 不同步：API key、OAuth token、信任决定、工具权限、锁、运行中的任务、Coding 模式的聊天与仓库，以及其它 Web 偏好。
- 合并用的是稳定 key 加按设备的版本向量：记忆按与双方最后一致版本的差异做三方合并，聊天按 entry id 合并所以两条分支都保留，合不了的冲突保留本地版本、把对方存成可恢复副本并列在设置里。Drive 传来的数据不能授予项目信任、不能执行命令。
- 边界：这是对 Drive API 的真实实现，但自动化测试用的是内存传输，尚未在真实双机 Google 账号上跑通。退出应用后同步停止，且没有端到端加密。详见 [Google Drive sync](packages/coding-agent/docs/google-drive-sync.md)。

## Quick Start（Windows）

环境要求：

- Windows 10 或 11，x64；
- 从源码运行时需要 Node.js `>=22.19.0`；
- 如果要在 Windows 使用 `bash` tool，需要安装 Git for Windows；
- 一个已配置的 Provider、model，以及该 Provider 所需的凭据。

```powershell
git clone https://github.com/h3327725338-star/MyHarness.git
cd MyHarness
npm.cmd install --ignore-scripts
npm.cmd run build
.\dev-desktop.cmd
```

`dev-desktop.cmd` 会构建并启动 Electron 桌面端，这是日常使用 MyHarness 的方式。需要在命令行直接跑源码时，在仓库根目录执行 `node --import ./scripts/dev-fast-loader.mjs ./packages/coding-agent/src/web.ts`；它不会打开浏览器，会在日志中打印实际地址 `MyHarness Web UI: <url>`。

启动后，在 `/settings` 中配置 Provider 和 model，再输入任务。配置说明见 [Providers](packages/coding-agent/docs/providers.md) 和 [Settings](packages/coding-agent/docs/settings.md)。

没有 Provider 凭据时，可以先检查 Web 源码入口是否能够启动：

```powershell
node --import ./scripts/dev-fast-loader.mjs ./packages/coding-agent/src/web.ts --help
```

这个 smoke check 不能证明外部 Provider、OAuth flow、Web Search service 或真实 model conversation 已经成功。

## 评估本项目

[Judge testing guide](docs/JUDGE_TESTING.md) 写了“下载或自行构建”、如何挂上 Nebius Token Factory 凭据、五分钟测试脚本、源码该看哪里，以及已知限制。

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

## License

MyHarness 自有代码使用 [Apache License 2.0](LICENSE)。继承代码和第三方组件继续保留各自的 license、copyright 和 attribution，详见 [NOTICE](NOTICE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
