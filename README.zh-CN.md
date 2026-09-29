# MyHarness

[English](README.md) | [简体中文](README.zh-CN.md)

[![License: Apache-2.0](https://img.shields.io/github/license/h3327725338-star/MyHarness)](LICENSE)

MyHarness 是一个面向项目目录的终端 AI 编程协作工具，处于 Early-stage / Work in Progress 阶段。它把已配置的 LLM Provider 与项目文件、Shell 命令、工具和可恢复 Session 连接到同一个工作流中。

> 当前状态：项目主要在 Windows x64 源码 checkout 上维护和验证。使用真实模型会话前，需要配置 Provider、model 以及对应凭据。

## 核心能力

- **代码协作**：Coding Agent 产品层提供文件、Shell、PowerShell、编辑、写入、Symbols、Git 和 GitHub 工作流。
- **入口**：终端 TUI（Interactive）、Print 和 JSON event stream 模式；本机浏览器 **Web UI**（`myharness --web`，只监听 loopback，与 CLI 共用同一套 runtime）；也提供 Node.js SDK 供进程内集成。
- **项目上下文**：支持 project trust、`AGENTS.md` / `CLAUDE.md` context files、Workspace 与 Session 管理、Git 集成和 context compaction。
- **可扩展**：支持 TypeScript extensions、skills、prompt templates、themes、custom Provider 和 MyHarness packages。
- **Code Intelligence**：源码中提供 lightweight Symbols index。语义 language-server 模块仍是可选能力，只有在发布并提供校验值的 runtime manifest 后才会可用。
- **可选工作流**：可按配置启用 Explore sub-agent、`/workflow`、`/ultracode` 和 Web Search；Web Search 需要兼容的外部服务。

源码和当前状态文档会明确区分“已经实现的 contract”“已经加载的运行时配置”和“依赖机器、凭据或外部服务的验证结果”。当前 checkout 不内置默认 Provider/model catalog。

## Quick Start（Windows 源码运行）

环境要求：

- Node.js `>=22.19.0`；
- 如果要在 Windows 使用 `bash` tool，需要安装 Git for Windows；
- 一个已配置的 Provider、model，以及该 Provider 所需的凭据。

```powershell
git clone https://github.com/h3327725338-star/MyHarness.git
cd MyHarness
npm.cmd install --ignore-scripts
npm.cmd run build
.\dev.cmd
```

启动后，在 `/settings` 中配置 Provider 和 model，再输入任务。配置说明见 [Providers](packages/coding-agent/docs/providers.md) 和 [Settings](packages/coding-agent/docs/settings.md)。

没有 Provider 凭据时，可以先检查源码 CLI 是否能够启动：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\myharness-test.ps1 --help
```

这个 smoke check 不能证明外部 Provider、OAuth flow、Web Search service 或真实 model conversation 已经成功。

## 文档

- [Coding Agent 中文文档索引](packages/coding-agent/docs/index.zh-CN.md)
- [Quickstart](packages/coding-agent/docs/quickstart.md)
- [使用说明与 CLI 参考](packages/coding-agent/docs/usage.md)
- [Provider 与 model](packages/coding-agent/docs/providers.md)
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
